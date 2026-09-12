import { closeDatabase, db } from "@/db";
import * as schema from "@/db/schema";

/**
 * IMPERIO RP — ¿El esquema del código coincide con el de la base?
 *
 * TypeScript comprueba que el código y el esquema estén de acuerdo, y las
 * migraciones llevan el esquema a la base. Pero nada comprueba el tercer lado
 * del triángulo: que la base tenga de verdad lo que el esquema dice.
 *
 * Cuando no coinciden, el resultado es feo y tardío. Una columna declarada que
 * la base no tiene compila perfecto, pasa los tests —que no tocan la base— y
 * revienta recién cuando alguien abre esa pantalla en producción, porque
 * Drizzle pide TODAS las columnas declaradas en cada `select`.
 *
 * Esto hace una consulta trivial por tabla y dice cuáles fallan. Es un minuto
 * de corrida y cubre un agujero entero.
 *
 *   pnpm db:smoke
 */

type Tabla = { readonly nombre: string; readonly tabla: unknown };

function tablasDelEsquema(): readonly Tabla[] {
  const tablas: Tabla[] = [];

  for (const [nombre, valor] of Object.entries(schema)) {
    // Las tablas de Drizzle se reconocen por su símbolo interno; lo demás del
    // módulo son tipos y ayudantes.
    const esTabla =
      typeof valor === "object" &&
      valor !== null &&
      Object.getOwnPropertySymbols(valor).some((s) => s.description?.includes("drizzle:Name"));

    if (esTabla) tablas.push({ nombre, tabla: valor });
  }

  return tablas.sort((a, b) => a.nombre.localeCompare(b.nombre));
}

async function main(): Promise<void> {
  const tablas = tablasDelEsquema();
  console.log("\nComprobando " + tablas.length + " tablas contra la base…\n");

  const rotas: { nombre: string; error: string }[] = [];

  for (const { nombre, tabla } of tablas) {
    try {
      // `limit 0` no trae ni una fila, pero obliga a PostgreSQL a resolver
      // todas las columnas declaradas. Es exactamente lo que falla cuando el
      // esquema dice una cosa y la base tiene otra.
      await db
        .select()
        .from(tabla as never)
        .limit(0);
      console.log("  ok    " + nombre);
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      // Del error de PostgreSQL, la parte útil es qué columna falta.
      const columna = /column "?([\w.]+)"? does not exist/i.exec(mensaje)?.[1];
      const resumen = columna ? "falta la columna " + columna : mensaje.slice(0, 160);

      console.log("  FALLA " + nombre + " — " + resumen);
      rotas.push({ nombre, error: resumen });
    }
  }

  await closeDatabase();

  if (rotas.length > 0) {
    console.error(
      "\n" +
        rotas.length +
        " tabla(s) no coinciden con el esquema.\n" +
        "Si la columna es nueva, falta la migración. Si sobra en el código, sacala del esquema.\n",
    );
    process.exit(1);
  }

  console.log("\nTodo coincide.\n");
}

void main().catch((error: unknown) => {
  console.error("\n" + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
});
