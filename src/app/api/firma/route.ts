import { NextResponse } from "next/server";

import { getCurrentSession } from "@/lib/auth/session";
import { logger } from "@/lib/core/logger";
import { firmaDeDatos } from "@/server/firma";

export const dynamic = "force-dynamic";

const SIN_CACHE = { "Cache-Control": "no-store" } as const;

/**
 * La firma de los datos, para el refresco en vivo. Ver `server/firma.ts`.
 *
 * Pide sesión como cualquier pantalla. La firma no dice nada de nadie, pero sí
 * dice cuándo hay movimiento en el panel, y eso tampoco tiene por qué ser
 * público.
 */
export async function GET(): Promise<NextResponse> {
  const sesion = await getCurrentSession();
  if (!sesion) return NextResponse.json({ ok: false }, { status: 401, headers: SIN_CACHE });

  try {
    return NextResponse.json({ ok: true, firma: await firmaDeDatos() }, { headers: SIN_CACHE });
  } catch (error) {
    logger.warn("No se pudo calcular la firma de los datos", { error });
    return NextResponse.json({ ok: false }, { status: 503, headers: SIN_CACHE });
  }
}
