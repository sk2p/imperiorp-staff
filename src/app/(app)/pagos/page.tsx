import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { WeekSelector } from "@/components/ui/filters";
import { PeriodBanner } from "@/components/ui/period-banner";
import { ProgressMeter } from "@/components/ui/charts";
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
  buttonClass,
} from "@/components/ui/primitives";
import { localDateTime } from "@/domain/clock";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { formatPeriodLabel, formatCalendarDateShort } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { getPaymentBoard, getPaymentSummary, getSettlement } from "@/server/payments";
import { getCurrentWeek, getWeekDetail, listWeekOptions } from "@/server/weeks";
import { PaymentBoardTable, PaymentLegend } from "./payment-board";
import { BulkPayDialog, PayDialog, VoidPaymentDialog } from "./payment-dialogs";

export const metadata: Metadata = { title: "Pagos" };
export const dynamic = "force-dynamic";

export default async function PaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ periodo?: string }>;
}) {
  const { can } = await requirePermission(PERMISSIONS.PAYMENTS_VIEW);
  const params = await searchParams;

  const weekOptions = await listWeekOptions();
  const currentWeek = await getCurrentWeek();
  const weekId =
    (params.periodo && weekOptions.some((week) => week.id === params.periodo)
      ? params.periodo
      : null) ??
    // Por defecto se muestra el último período CERRADO: es el que se paga.
    weekOptions.find((week) => week.status === "closed")?.id ??
    currentWeek?.id ??
    weekOptions[0]?.id ??
    null;

  if (!weekId) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Pagos" description="Registro de liquidaciones pagadas." />
        <Card>
          <EmptyState
            icon={<Icon name="wallet" size={20} />}
            title="Todavía no hay períodos"
            description="Creá un período, cargá horas y cerralo para poder registrar pagos."
          />
        </Card>
      </div>
    );
  }

  // La liquidación alimenta al tablero y al detalle: se trae una sola vez.
  const rows = await getSettlement(weekId);
  const [week, summary, board] = await Promise.all([
    getWeekDetail(weekId),
    getPaymentSummary(weekId),
    getPaymentBoard(weekId, rows),
  ]);

  if (!week) return null;

  const pending = rows.filter((row) => !row.paymentId && row.amount > 0);
  const paid = rows.filter((row) => row.paymentId);
  const isClosed = week.status === "closed";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operación"
        title="Pagos"
        description="Quién cobró, cuánto, por qué período, cuándo y quién lo registró."
        actions={
          <>
            <WeekSelector weeks={weekOptions} currentId={weekId} />
            {/*
              La liquidación en Excel.

              El día que haya una discusión de plata —y en un sistema que
              reparte sueldos la va a haber— nadie la resuelve pasándose
              capturas. Se resuelve con la planilla del período abierta en la
              pantalla de los dos.

              Es un enlace y no un botón con JavaScript: el navegador sabe bajar
              archivos solo, y así anda igual con la pestaña a medio cargar.
            */}
            {can(PERMISSIONS.DATA_EXPORT) ? (
              <a
                href={"/api/exportar/liquidacion?periodo=" + weekId}
                className={buttonClass("secondary", "sm")}
                download
                title="Bajar la liquidación de este período en Excel"
              >
                <Icon name="download" size={14} />
                Excel
              </a>
            ) : null}
            {isClosed && pending.length > 0 && can(PERMISSIONS.PAYMENTS_CREATE) ? (
              <BulkPayDialog
                weekId={weekId}
                pendingIds={pending.map((row) => row.staffMemberId)}
                pendingCount={pending.length}
                pendingAmount={summary.pendingAmount}
              />
            ) : null}
          </>
        }
      />

      <PeriodBanner
        startDate={week.startDate}
        endDate={week.endDate}
        status={week.status}
        isCurrent={week.id === currentWeek?.id}
        accion="Pagando el período"
        currentHref={currentWeek && week.id !== currentWeek.id ? "/pagos" : undefined}
      />

      {/*
        El cartel decía que los pagos se registran con el período cerrado, y
        abajo el tablero los dejaba marcar igual. Decir una cosa y hacer otra es
        peor que cualquiera de las dos por separado: quien lee el cartel y marca
        igual deja de creerle a los carteles.
        Se puede pagar en abierto — es lo que se hace en la práctica — así que
        el aviso pasó a decir lo único que importa saber: que el importe todavía
        se puede mover abajo de los pies.
      */}
      {!isClosed ? (
        <Callout tone="warning" title="Este período todavía está abierto">
          Se puede pagar igual, pero las horas pueden seguir cambiando: si alguien carga o corrige
          una hora después de que marcaste a alguien como pagado, el importe abonado deja de
          coincidir con el que corresponde. La fila lo avisa cuando pasa.{" "}
          <Link href="/periodos" className="font-semibold underline underline-offset-2">
            Cerrar el período congela los importes
          </Link>
        </Callout>
      ) : null}

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Período"
          value={
            formatCalendarDateShort(week.startDate) + " → " + formatCalendarDateShort(week.endDate)
          }
          hint={formatPeriodLabel(week.startDate, week.endDate)}
        />
        <Stat
          label="Total a pagar"
          value={formatMoneyCompact(summary.totalAmount)}
          hint={formatMoney(summary.totalAmount)}
        />
        <Stat
          label="Pagado"
          value={formatMoneyCompact(summary.paidAmount)}
          hint={summary.paidCount + " liquidaciones"}
        />
        <Stat
          label="Pendiente"
          value={formatMoneyCompact(summary.pendingAmount)}
          hint={summary.pendingCount + " liquidaciones"}
          accent={summary.pendingCount > 0}
        />
      </div>

      <Card>
        <div className="p-4">
          <ProgressMeter
            label="Avance de la liquidación"
            value={summary.paidCount}
            total={summary.paidCount + summary.pendingCount}
          />
        </div>
      </Card>

      {/* Tablero: el staff entero por categoría, con las horas y lo que cobra
          cada uno. Es la vista que se usa mientras se paga. */}
      <Card>
        <CardHeader
          title="Staff por categoría"
          description="Click derecho sobre una fila para marcarla como pagada o como pendiente."
          action={<PaymentLegend pendingCount={board.pendingCount} paidCount={board.paidCount} />}
        />
        {board.groups.length === 0 ? (
          <EmptyState
            icon={<Icon name="users" size={20} />}
            title="Nadie en este período"
            description="Cargá horas en la planilla y el staff va a aparecer acá."
          />
        ) : (
          <PaymentBoardTable
            board={board}
            weekId={weekId}
            canPay={can(PERMISSIONS.PAYMENTS_CREATE)}
            canVoid={can(PERMISSIONS.PAYMENTS_VOID)}
            isClosed={isClosed}
          />
        )}
      </Card>

      {/* Detalle. El tablero de arriba alcanza para el día a día; esto es para
          cuando hay que pagar un importe distinto al calculado o revisar quién
          registró cada pago. */}
      <Card>
        <CardHeader
          title={"Pendientes (" + pending.length + ")"}
          description="Para pagar un importe distinto al calculado, con su motivo."
        />
        {pending.length === 0 ? (
          <EmptyState
            icon={<Icon name="check" size={20} />}
            title="No queda nada pendiente"
            description="Todas las liquidaciones con horas de este período ya están pagadas."
          />
        ) : (
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Miembro</th>
                  <th>Rango</th>
                  <th className="text-right">Horas</th>
                  <th className="text-right">Tarifa</th>
                  <th className="text-right">Le corresponde</th>
                  {can(PERMISSIONS.PAYMENTS_CREATE) ? <th className="text-right">Acción</th> : null}
                </tr>
              </thead>
              <tbody className="stagger">
                {pending.map((row) => (
                  <tr key={row.recordId}>
                    <td className="text-chalk-100 font-medium">{row.name}</td>
                    <td>
                      <Badge tone="muted">{row.rank}</Badge>
                    </td>
                    <td className="tnum text-right font-semibold">
                      {formatMinutes(row.totalMinutes)}
                    </td>
                    <td className="tnum text-chalk-500 text-right text-xs">
                      {formatMoneyCompact(row.hourlyRate)}/h
                    </td>
                    <td className="tnum text-imperial-400 text-right text-sm font-bold">
                      {formatMoney(row.amount)}
                    </td>
                    {can(PERMISSIONS.PAYMENTS_CREATE) ? (
                      <td className="text-right">
                        {isClosed ? (
                          <PayDialog
                            weekId={weekId}
                            staffMemberId={row.staffMemberId}
                            name={row.name}
                            rank={row.rank}
                            minutes={row.totalMinutes}
                            amount={row.amount}
                          />
                        ) : (
                          <span className="text-chalk-600 text-xs">Cerrá el período</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Pagados */}
      <Card>
        <CardHeader
          title={"Pagados (" + paid.length + ")"}
          description="Con fecha, hora y responsable de cada registro."
        />
        {paid.length === 0 ? (
          <EmptyState icon={<Icon name="wallet" size={20} />} title="Sin pagos en este período" />
        ) : (
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Miembro</th>
                  <th>Rango</th>
                  <th className="text-right">Horas</th>
                  <th className="text-right">Importe</th>
                  <th>Pagado</th>
                  <th>Registrado por</th>
                  {can(PERMISSIONS.PAYMENTS_VOID) ? <th className="text-right">Acción</th> : null}
                </tr>
              </thead>
              <tbody className="stagger">
                {paid.map((row) => (
                  <tr key={row.recordId}>
                    <td className="text-chalk-100 font-medium">{row.name}</td>
                    <td>
                      <Badge tone="muted">{row.rank}</Badge>
                    </td>
                    <td className="tnum text-right">{formatMinutes(row.totalMinutes)}</td>
                    <td className="tnum text-jade-400 text-right font-semibold">
                      {formatMoney(row.paidAmount ?? 0)}
                      {row.paidAmount !== row.amount ? (
                        <span className="block text-[0.6875rem] font-normal text-amber-400">
                          calculado {formatMoneyCompact(row.amount)}
                        </span>
                      ) : null}
                    </td>
                    <td className="tnum text-chalk-400 text-xs whitespace-nowrap">
                      {row.paidAt ? localDateTime(row.paidAt) : ""}
                    </td>
                    <td className="text-chalk-400 text-xs">
                      {row.paidByUsername}
                      {row.paymentReference ? (
                        <span className="mono text-chalk-600 ml-1.5">{row.paymentReference}</span>
                      ) : null}
                    </td>
                    {can(PERMISSIONS.PAYMENTS_VOID) ? (
                      <td className="text-right">
                        {row.paymentId ? (
                          <VoidPaymentDialog
                            paymentId={row.paymentId}
                            version={row.paymentVersion ?? 1}
                            name={row.name}
                            amount={row.paidAmount ?? 0}
                          />
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
