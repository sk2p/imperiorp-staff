import { sql } from "drizzle-orm";

import { db } from "@/db";

/**
 * IMPERIO RP — La firma de los datos.
 *
 * Una cadena corta que cambia cada vez que cambia algo que alguna pantalla
 * muestra. La usa el refresco en vivo para preguntar "¿hay algo nuevo?" antes
 * de volver a dibujar la pantalla entera.
 *
 * Por qué hace falta: el refresco pedía la página completa cada doce segundos,
 * hubiera cambios o no. Cada pedido es el armazón y la pantalla enteros —en
 * Inicio, más de una docena de consultas—, por cada pestaña abierta, todo el
 * día. En el plan gratuito de Neon eso es la base despierta sin descanso para
 * mostrar exactamente lo mismo. Con la firma, una pantalla que nadie toca
 * cuesta una consulta chica.
 *
 * CÓMO SE ENTERA, y por qué así:
 *
 * La primera versión miraba la auditoría y los fichajes, contando con que todo
 * lo demás dejara registro. No alcanzaba: sumar a alguien a la planilla del
 * período abierto crea filas de horas sin auditar, y la pantalla no se movía.
 * Una firma que depende de que cada función se acuerde de avisar se rompe en
 * silencio la próxima vez que alguien escriba una función nueva.
 *
 * Ahora mira las tablas directamente. Por cada una, dos números:
 *
 *   · Cuántas filas tiene. Cambia con cada alta y cada baja.
 *   · El `xmin` más nuevo: el número de la transacción que escribió cada fila,
 *     que PostgreSQL renueva en CADA modificación. Si alguien tocó una fila
 *     —desde la página, desde el bot o a mano en la consola de la base—, ese
 *     número sube.
 *
 * No depende de que nadie audite, ni de que actualice `updated_at`. Recorre
 * tablas de a lo sumo unos miles de filas: para una consulta cada doce
 * segundos, es nada.
 */

/** Las tablas cuyo contenido aparece en alguna pantalla. */
const TABLAS = [
  "shift_sessions",
  "hour_entries",
  "weeks",
  "weekly_staff_records",
  "payments",
  "staff_members",
  "staff_rank_history",
  "rank_rates",
  "system_settings",
] as const;

/**
 * La consulta se arma una sola vez. Los nombres son fijos, de esta lista: no
 * entra nada que venga de afuera.
 */
const CONSULTA = sql.raw(
  "select concat_ws(':', " +
    '(select coalesce(max("audit_logs"."sequence"), 0)::text from audit_logs), ' +
    TABLAS.map(
      (tabla) =>
        "(select count(*)::text || '.' || coalesce(max(\"" +
        tabla +
        '"."xmin"::text::bigint), 0)::text from ' +
        tabla +
        ")",
    ).join(", ") +
    ") as firma",
);

export async function firmaDeDatos(): Promise<string> {
  const resultado = await db.execute<{ firma: string | null }>(CONSULTA);
  return resultado.rows?.[0]?.firma ?? "-";
}
