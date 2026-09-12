import { NextResponse, type NextRequest } from "next/server";

import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";
import { rotatePeriodIfDue } from "@/server/rotation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Rotación automática del período.
 *
 * La dispara el programador de Vercel todos los días; la tarea decide sola si
 * corresponde cerrar y abrir. Ver `src/server/rotation.ts` para el criterio.
 *
 * SEGURIDAD: el endpoint cambia datos —cierra liquidaciones—, así que exige un
 * secreto compartido. Vercel lo envía en `Authorization: Bearer $CRON_SECRET`.
 * Sin `CRON_SECRET` definido, la ruta queda cerrada en producción: es preferible
 * que la rotación no ocurra a que cualquiera pueda cerrar el período del staff
 * llamando a una URL.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");

  if (!secret) {
    if (getEnv().NODE_ENV === "production") {
      logger.error("CRON_SECRET no está definida: la rotación automática queda deshabilitada");
      return NextResponse.json(
        { ok: false, error: "La tarea programada no está configurada." },
        { status: 503 },
      );
    }
  } else if (authorization !== "Bearer " + secret) {
    logger.warn("Intento de ejecutar la rotación sin credencial válida");
    return NextResponse.json({ ok: false, error: "No autorizado." }, { status: 401 });
  }

  try {
    const result = await rotatePeriodIfDue();

    logger.info("Rotación de período evaluada", {
      actuó: result.acted,
      motivo: result.reason,
    });

    return NextResponse.json(
      {
        ok: true,
        acted: result.acted,
        reason: result.reason,
        ...(result.closedWeek ? { closed: result.closedWeek } : {}),
        ...(result.openedWeek ? { opened: result.openedWeek } : {}),
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logger.error("Falló la rotación automática del período", { error });
    return NextResponse.json(
      { ok: false, error: "No se pudo rotar el período. Revisá los logs del servidor." },
      { status: 500 },
    );
  }
}
