import ExcelJS from "exceljs";
import { NextResponse, type NextRequest } from "next/server";

import { PERMISSIONS } from "@/domain/permissions";
import { formatPeriodLabel } from "@/domain/periods";
import { toDecimalHours } from "@/domain/time";
import { requirePermission, type ActorContext } from "@/lib/auth/context";
import { httpStatusFor, serializeError } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";
import { logAudit } from "@/server/audit";
import { getSettlement } from "@/server/payments";
import { requireWeek } from "@/server/weeks";
import { uuidSchema } from "@/validation/common";

export const dynamic = "force-dynamic";

/**
 * La liquidación de un período, en un archivo de Excel.
 *
 * Por qué existe: el día que haya una discusión de plata —y en un sistema que
 * reparte sueldos, la va a haber— nadie la resuelve pasándose capturas de
 * pantalla. Se resuelve con la planilla del período abierta en la pantalla de
 * los dos. Esto la baja.
 *
 * Qué lleva y por qué:
 *
 *   · El rango y la tarifa SON los del período, no los de hoy. Es la foto
 *     congelada de la fila, la misma con la que se pagó. Un archivo que dijera
 *     el rango actual serviría para discutir cualquier cosa menos lo que pasó.
 *   · Las horas van en dos columnas: como se leen —"17h 6m"— y en decimal, que
 *     es lo que hace falta para multiplicar en la propia planilla si alguien
 *     quiere rehacer la cuenta.
 *   · El importe calculado y el efectivamente pagado, separados. Cuando no
 *     coinciden, el archivo lo muestra en una columna aparte en vez de elegir
 *     uno de los dos.
 *
 * Queda registrado en la auditoría: bajarse los sueldos de cuarenta personas es
 * exactamente la clase de cosa que tiene que dejar rastro.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  /**
   * Sin sesión o sin permiso: 401 o 403, con su mensaje.
   *
   * La excepción de `requirePermission` salía de la ruta sin atrapar y Next la
   * convertía en un 500. El archivo no se entregaba igual, pero para quien mira
   * de afuera decía "se rompió el servidor" en vez de "no tenés acceso", y en
   * los logs quedaba un error falso por cada visita sin sesión.
   */
  let actor: ActorContext;
  try {
    ({ actor } = await requirePermission(PERMISSIONS.DATA_EXPORT));
  } catch (error) {
    return NextResponse.json(serializeError(error), {
      status: httpStatusFor(error),
      headers: { "Cache-Control": "no-store" },
    });
  }

  const weekId = request.nextUrl.searchParams.get("periodo");
  if (!weekId) {
    return NextResponse.json({ ok: false, error: "Falta el período." }, { status: 400 });
  }
  // Un identificador inventado llegaba a la base y volvía como error interno.
  if (!uuidSchema.safeParse(weekId).success) {
    return NextResponse.json({ ok: false, error: "Período inválido." }, { status: 400 });
  }

  try {
    const week = await requireWeek(weekId);
    const filas = await getSettlement(weekId);

    const etiqueta = formatPeriodLabel(week.startDate, week.endDate);

    const libro = new ExcelJS.Workbook();
    libro.creator = "Imperio RP — Gestión de staff";
    libro.created = new Date();

    const hoja = libro.addWorksheet("Liquidación", {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    hoja.columns = [
      { header: "Staff", key: "nombre", width: 22 },
      { header: "Rango", key: "rango", width: 10 },
      { header: "Horas", key: "horas", width: 11 },
      { header: "Horas (decimal)", key: "decimal", width: 15 },
      { header: "Tarifa por hora", key: "tarifa", width: 16 },
      { header: "Le corresponde", key: "corresponde", width: 16 },
      { header: "Estado", key: "estado", width: 13 },
      { header: "Pagado", key: "pagado", width: 16 },
      { header: "Diferencia", key: "diferencia", width: 14 },
      { header: "Pagó", key: "pago", width: 14 },
      { header: "Fecha del pago", key: "fecha", width: 16 },
    ];

    for (const fila of filas) {
      const pagado = fila.paymentId !== null;
      const importePagado = fila.paidAmount ?? 0;

      hoja.addRow({
        nombre: fila.name,
        rango: fila.rank,
        horas: Math.floor(fila.totalMinutes / 60) + "h " + (fila.totalMinutes % 60) + "m",
        decimal: toDecimalHours(fila.totalMinutes),
        tarifa: fila.hourlyRate,
        corresponde: fila.amount,
        estado: pagado ? "Pagado" : "Falta pagar",
        pagado: pagado ? importePagado : null,
        // Sólo cuando hay algo que mirar: una diferencia de cero es ruido.
        diferencia: pagado && importePagado !== fila.amount ? importePagado - fila.amount : null,
        pago: fila.paidByUsername ?? "",
        fecha: fila.paidAt ?? "",
      });
    }

    const totalMinutos = filas.reduce((suma, fila) => suma + fila.totalMinutes, 0);
    const totalImporte = filas.reduce((suma, fila) => suma + fila.amount, 0);
    const totalPagado = filas.reduce(
      (suma, fila) => suma + (fila.paymentId !== null ? (fila.paidAmount ?? 0) : 0),
      0,
    );

    hoja.addRow({});
    const total = hoja.addRow({
      nombre: "TOTAL · " + filas.length + " personas",
      horas: Math.floor(totalMinutos / 60) + "h " + (totalMinutos % 60) + "m",
      decimal: toDecimalHours(totalMinutos),
      corresponde: totalImporte,
      pagado: totalPagado,
      diferencia: totalPagado - totalImporte,
    });

    total.font = { bold: true };
    hoja.getRow(1).font = { bold: true };

    // El formato de moneda se aplica a la columna entera, con separador de
    // miles: una cifra de ocho dígitos sin separar no la lee nadie.
    for (const clave of ["tarifa", "corresponde", "pagado", "diferencia"]) {
      hoja.getColumn(clave).numFmt = "#,##0;[Red]-#,##0";
    }
    hoja.getColumn("decimal").numFmt = "0.00";
    hoja.getColumn("fecha").numFmt = "dd/mm/yyyy hh:mm";

    hoja.autoFilter = { from: "A1", to: "K1" };

    const buffer = await libro.xlsx.writeBuffer();

    await logAudit({
      actor,
      action: "DATA_EXPORTED",
      entity: "weeks",
      entityId: week.id,
      summary: "Exportó la liquidación de " + etiqueta + " (" + filas.length + " filas)",
      metadata: { formato: "xlsx", filas: filas.length, totalImporte },
    });

    const nombre = "imperio-liquidacion-" + week.startDate + "_" + week.endDate + ".xlsx";

    return new NextResponse(buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="' + nombre + '"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    logger.error("Falló la exportación de la liquidación", { error, weekId });
    return NextResponse.json(
      { ok: false, error: "No se pudo generar el archivo." },
      { status: 500 },
    );
  }
}
