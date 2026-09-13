import { createReadStream } from "node:fs";
import fs from "node:fs";
import { createGunzip } from "node:zlib";

import { sql } from "drizzle-orm";

import { closeDatabase, db } from "@/db";

/**
 * IMPERIO RP — Probar que una copia de seguridad se puede restaurar.
 *
 * Una copia que nunca se restauró no es una copia: es un archivo que da
 * tranquilidad hasta el día que hace falta. Esto agarra la copia más reciente,
 * la mete en una base VACÍA y compara los recuentos.
 *
 * Cómo se usa, y por qué apuntando a otra base:
 *
 *   1. Dejar `DATABASE_URL` sin definir en un `.env` aparte, para que use la
 *      base embebida de desarrollo.
 *   2. `tsx --env-file=.env.prueba src/db/migrate.ts`  ← crea las tablas.
 *   3. `pnpm db:verificar-copia`
 *
 * Se niega a correr si la base tiene datos. No es una restauración de verdad
 * —para eso está el archivo `.sql` y cualquier cliente de PostgreSQL—, es la
 * prueba de que ese archivo sirve.
 */

const archivo =
  "copias/" +
  fs
    .readdirSync("copias")
    .filter((n) => n.endsWith(".sql.gz"))
    .sort()
    .pop()!;

let texto = "";
await new Promise<void>((ok, mal) => {
  const flujo = createReadStream(archivo).pipe(createGunzip());
  flujo.on("data", (trozo) => {
    texto += trozo.toString();
  });
  flujo.on("end", () => ok());
  flujo.on("error", mal);
});

const habitada = await db.execute<{ total: number }>(
  sql`select (select count(*) from users) + (select count(*) from staff_members) as total`,
);

if (Number(habitada.rows?.[0]?.total ?? 0) > 0) {
  console.log(
    "\n  La base tiene datos. Esta prueba sólo corre contra una base vacía:\n" +
      "  meter una copia encima de datos existentes no prueba nada y puede ensuciar todo.\n",
  );
  process.exit(1);
}

console.log("archivo: " + archivo + " | caracteres: " + texto.length);

// Una sentencia por vez: una consulta preparada no acepta varias juntas. `psql`
// sí las acepta, pero esta verificación corre contra la base embebida. El corte
// va por la marca que escribe la copia, no por punto y coma: un dato puede
// tener un punto y coma adentro.
const sentencias = texto
  .split("-- @fin")
  // Cada trozo puede empezar con comentarios ("-- weeks: 3 filas"). Se sacan
  // las líneas de comentario y se conserva la sentencia; descartar el trozo
  // entero por empezar con un comentario tira sentencias reales a la basura.
  .map((trozo) =>
    trozo
      .split("\n")
      .filter((linea) => !linea.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter((t) => t.length > 0);

console.log("sentencias: " + sentencias.length);

for (const sentencia of sentencias) {
  await db.execute(sql.raw(sentencia));
}

const tablas = [
  "users",
  "staff_members",
  "weeks",
  "weekly_staff_records",
  "hour_entries",
  "payments",
  "audit_logs",
  "shift_sessions",
];

for (const tabla of tablas) {
  const r = await db.execute(sql.raw('select count(*)::int as c from "' + tabla + '"'));
  console.log("  " + tabla.padEnd(22) + String((r.rows ?? [])[0]?.c).padStart(6));
}

await closeDatabase();
process.exit(0);
