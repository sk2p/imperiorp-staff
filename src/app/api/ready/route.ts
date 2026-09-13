import { NextResponse, type NextRequest } from "next/server";

import { checkDatabaseHealth } from "@/db";
import { pendingMigrations } from "@/db/migrate";
import { getAuthContext } from "@/lib/auth/context";
import { portadorValido } from "@/lib/auth/secreto-compartido";
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

/**
 * Quién ve el detalle.
 *
 * El código de estado —200 listo, 503 degradado— es para cualquiera: es lo que
 * miran el hosting y los chequeos después de un despliegue. El detalle dice
 * cómo está armado el servidor por dentro: si falta el token de Discord,
 * cuántas migraciones hay, y una huella del secreto con el que se firman las
 * sesiones. Antes lo veía cualquiera; ahora, un Fundador con sesión o quien
 * mande el secreto de las tareas programadas.
 *
 * La huella no permite recuperar un secreto bien generado, pero con uno débil
 * sirve para comprobar adivinanzas sin tocar el servidor. No hay por qué darla.
 */
async function puedeVerDetalle(request: NextRequest): Promise<boolean> {
  if (portadorValido(request.headers.get("authorization"), process.env.CRON_SECRET)) return true;

  // Con la base caída no hay sesión que validar: se contesta sólo el estado.
  const contexto = await getAuthContext().catch(() => null);
  return contexto?.user.role === "FOUNDER";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const database = await checkDatabaseHealth();
  const configProblems = assertProductionSafety();

  /**
   * Migraciones pendientes.
   *
   * Donde las migraciones no corren al arrancar, el código nuevo puede quedar
   * desplegado contra un esquema viejo: la aplicación arranca, responde, y
   * revienta recién cuando alguien abre una pantalla que usa la columna que
   * falta. Esto lo hace visible sin tener que entrar a la aplicación.
   */
  const migrations = database.ok ? await pendingMigrations() : null;
  const ready = database.ok && configProblems.length === 0 && (migrations?.pending ?? 0) === 0;

  const status = ready ? "ready" : "degraded";
  const opciones = { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } };

  if (!(await puedeVerDetalle(request))) {
    return NextResponse.json({ status, timestamp: new Date().toISOString() }, opciones);
  }

  return NextResponse.json(
    {
      status,
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
           */
          secretFingerprint: secretFingerprint(),
        },
        /**
         * Avisos de pago hacia Discord.
         *
         * Si falta cualquiera de las dos variables, la página registra el pago
         * igual pero no avisa a nadie, en silencio. Eso es imposible de
         * diagnosticar desde afuera, así que se informa acá. No dice el token
         * ni el canal, sólo si están.
         */
        discord: {
          ok: Boolean(process.env.DISCORD_TOKEN?.trim() && process.env.DISCORD_PAGOS?.trim()),
          token: Boolean(process.env.DISCORD_TOKEN?.trim()),
          canalPagos: Boolean(process.env.DISCORD_PAGOS?.trim()),
        },
        migrations: migrations
          ? {
              ok: migrations.pending === 0,
              applied: migrations.applied,
              pending: migrations.pending,
            }
          : { ok: false, applied: 0, pending: 0 },
      },
      timestamp: new Date().toISOString(),
    },
    opciones,
  );
}
