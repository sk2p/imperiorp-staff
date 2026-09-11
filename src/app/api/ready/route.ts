import { NextResponse } from "next/server";

import { checkDatabaseHealth } from "@/db";
import { assertProductionSafety } from "@/lib/core/env";
import { secretFingerprint } from "@/lib/core/fingerprint";

export const dynamic = "force-dynamic";

/**
 * Sonda de disponibilidad: indica si el servicio puede atender tráfico real.
 *
 * Comprueba la base de datos y la configuración de producción. La respuesta no
 * revela cadenas de conexión, credenciales ni rutas internas: sólo si cada
 * comprobación pasó y cuánto tardó.
 */
export async function GET(): Promise<NextResponse> {
  const database = await checkDatabaseHealth();
  const configProblems = assertProductionSafety();
  const ready = database.ok && configProblems.length === 0;

  return NextResponse.json(
    {
      status: ready ? "ready" : "degraded",
      checks: {
        database: {
          ok: database.ok,
          driver: database.driver,
          latencyMs: database.latencyMs,
        },
        configuration: {
          ok: configProblems.length === 0,
          problems: configProblems,
          /**
           * Huella del SESSION_SECRET con el que arrancó ESTE servidor.
           *
           * Sirve para comprobar que coincide con el que se usó al crear las
           * cuentas: si no coincide, ninguna contraseña funciona y el login
           * sólo dice "usuario o contraseña incorrectos", sin más pistas.
           * Son 8 caracteres de un SHA-256: no permiten recuperar el secreto.
           */
          secretFingerprint: secretFingerprint(),
        },
      },
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
