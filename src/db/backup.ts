import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import { sql } from "drizzle-orm";

import { closeDatabase, db } from "@/db";
import { logger } from "@/lib/core/logger";

/**
 * IMPERIO RP — Copia de seguridad de la base.
 *
 * Todo el sistema vive en una única base en la nube: las horas, los pagos, el
 * historial de rangos y la auditoría encadenada. Sin una copia afuera, un
 * borrado accidental o un problema del proveedor se lleva todo y no hay de
 * dónde volver. Esto es lo único que protege contra eso.
 *
 * POR QUÉ ESCRIBE SQL Y NO UN FORMATO PROPIO
 *
 * La primera versión guardaba las filas como JSON y traía su propio script para
 * volver a meterlas. Al probar esa restauración de verdad —contra una base
 * vacía, que es la única forma de saber si una copia sirve— apareció un
 * problema detrás de otro: los arrays de PostgreSQL que el ORM expandía en
 * parámetros sueltos, los `jsonb` que volvían como objeto, los tipos que la
 * base no podía inferir de un parámetro nulo. Cada uno tenía arreglo, y todos
 * juntos eran un restaurador a medio probar: exactamente lo que uno NO quiere
 * descubrir el día que tiene que usarlo.
 *
 * Esto escribe sentencias `insert` con los valores adentro. Se restaura con
 * cualquier cliente de PostgreSQL y sin una línea de código de este proyecto:
 *
 *   1. Base nueva y vacía en Neon.
 *   2. `pnpm db:migrate` apuntando ahí, para crear las tablas.
 *   3. Descomprimir el `.sql.gz` y correrlo con psql, o pegarlo en el editor
 *      SQL de Neon si es chico.
 *
 * El formato es la interfaz más vieja y más estable que hay para una base de
 * datos. Nada que pueda romperse por una versión distinta de una librería.
 *
 * Uso:
 *   pnpm db:backup                 ← guarda en ./copias
 *   pnpm db:backup C:/otra/ruta
 */

/**
 * Las tablas, en orden de dependencia.
 *
 * Importa para restaurar: una fila de `hour_entries` apunta a un período y a
 * una ficha, así que esas dos tienen que existir antes. El orden de esta lista
 * ES el orden de inserción del archivo.
 */
const TABLAS = [
  "users",
  "staff_members",
  "rank_rates",
  "rank_rate_history",
  "staff_rank_history",
  "weeks",
  "weekly_staff_records",
  "hour_entries",
  "payments",
  "shift_sessions",
  "sessions",
  "audit_logs",
  "security_events",
  "login_attempts",
  "system_settings",
  "import_batches",
] as const;

/** Cuántas copias se conservan. Las más viejas se borran solas. */
const CONSERVAR = 30;

/**
 * Cierre de cada sentencia.
 *
 * Un comentario SQL que ninguna base interpreta y que no puede aparecer adentro
 * de un dato. Partir el archivo por punto y coma parece obvio y no funciona: un
 * motivo escrito a mano o un campo JSON pueden tener uno adentro, y quien parta
 * así termina con sentencias cortadas al medio. Con una marca propia, cualquiera
 * que quiera correr esto de a pedazos sabe exactamente dónde cortar.
 */
const SEPARADOR = "\n-- @fin\n\n";

/** Cuántas filas entran en cada sentencia `insert`. */
const LOTE = 100;

export interface ResultadoCopia {
  readonly archivo: string;
  readonly bytes: number;
  readonly filas: number;
  readonly tablas: Record<string, number>;
}

function sello(fecha = new Date()): string {
  return fecha.toISOString().replace(/[:.]/g, "-").slice(0, 16);
}

/** Un identificador entre comillas dobles, con las internas duplicadas. */
function identificador(nombre: string): string {
  return '"' + nombre.replace(/"/g, '""') + '"';
}

/**
 * Un valor, escrito tal como PostgreSQL lo quiere leer.
 *
 * Las comillas simples se duplican, que es como se escapan en SQL. Un array se
 * escribe en la notación de llaves; un objeto, como texto JSON. Las fechas van
 * en ISO, que PostgreSQL entiende contra cualquier columna de fecha u hora.
 */
function literal(valor: unknown, tipo: string | undefined): string {
  if (valor === null || valor === undefined) return "NULL";
  if (typeof valor === "boolean") return valor ? "true" : "false";
  if (typeof valor === "number") return Number.isFinite(valor) ? String(valor) : "NULL";
  if (valor instanceof Date) return "'" + valor.toISOString() + "'";

  /**
   * Una lista puede ser dos cosas muy distintas y se escriben distinto.
   *
   * Los permisos de un usuario viajan como lista en JavaScript, pero en la base
   * son `jsonb`; el historial de errores de una importación también. Otras
   * columnas sí son arrays nativos de PostgreSQL. La misma lista se escribe
   * `["a","b"]` para una y `{"a","b"}` para la otra, y equivocarse da un error
   * de sintaxis al restaurar — el día menos indicado.
   *
   * Por eso el tipo se le pregunta a la base, no se adivina del valor.
   */
  if (Array.isArray(valor)) {
    if (tipo === "ARRAY") {
      const partes = valor.map((elemento) =>
        elemento === null
          ? "NULL"
          : '"' + String(elemento).split("\\").join("\\\\").split('"').join('\\"') + '"',
      );
      return "'" + ("{" + partes.join(",") + "}").split("'").join("''") + "'";
    }

    return "'" + JSON.stringify(valor).split("'").join("''") + "'";
  }

  if (typeof valor === "object") {
    return "'" + JSON.stringify(valor).split("'").join("''") + "'";
  }

  return "'" + String(valor).split("'").join("''") + "'";
}

/** Tipo de cada columna, preguntado a la base: tabla → columna → tipo. */
async function tiposDeColumnas(): Promise<Map<string, Map<string, string>>> {
  const resultado = await db.execute<{
    table_name: string;
    column_name: string;
    data_type: string;
  }>(sql`
    select table_name, column_name, data_type
      from information_schema.columns
     where table_schema = 'public'
  `);

  const mapa = new Map<string, Map<string, string>>();

  for (const fila of resultado.rows ?? []) {
    const columnas = mapa.get(fila.table_name) ?? new Map<string, string>();
    columnas.set(fila.column_name, fila.data_type);
    mapa.set(fila.table_name, columnas);
  }

  return mapa;
}

/**
 * Escribe la copia y devuelve qué guardó.
 *
 * Va comprimida y se genera de a chorros —una tabla por vez, lotes de cien
 * filas— para no armar el archivo entero en memoria. Con cuarenta personas hoy
 * da lo mismo; dentro de dos años, no.
 */
export async function crearCopia(carpeta: string): Promise<ResultadoCopia> {
  await mkdir(carpeta, { recursive: true });

  const archivo = path.join(carpeta, "imperio-" + sello() + ".sql.gz");
  const tablas: Record<string, number> = {};
  let filas = 0;

  const tipos = await tiposDeColumnas();

  const migraciones = await db
    .execute<{ total: number }>(
      sql`select count(*)::int as total from drizzle.__drizzle_migrations`,
    )
    .catch(() => ({ rows: [{ total: -1 }] }));

  async function* lineas(): AsyncGenerator<string> {
    yield "-- Imperio RP — copia de seguridad\n";
    yield "-- creada: " + new Date().toISOString() + "\n";
    yield "-- migraciones aplicadas: " + (migraciones.rows?.[0]?.total ?? -1) + "\n";
    yield "--\n";
    yield "-- Restaurar: base vacía + pnpm db:migrate, y después correr este archivo.\n";
    yield "-- Está pensado para entrar sobre tablas vacías; por las dudas, cada\n";
    yield "-- insert ignora las filas que ya existan.\n";
    yield "-- Cada sentencia termina con la marca:  -- @fin\n\n";
    yield "begin;" + SEPARADOR;

    for (const tabla of TABLAS) {
      // `sql.raw` porque el nombre de tabla no puede ir como parámetro; los
      // nombres salen de la lista de arriba, no de nada que venga de afuera.
      const resultado = await db.execute(sql.raw("select * from " + identificador(tabla)));
      const registros = (resultado.rows ?? []) as Record<string, unknown>[];

      tablas[tabla] = registros.length;
      filas += registros.length;

      if (registros.length === 0) continue;

      const columnas = Object.keys(registros[0] ?? {});
      yield "-- " + tabla + ": " + registros.length + " filas\n";

      for (let desde = 0; desde < registros.length; desde += LOTE) {
        const lote = registros.slice(desde, desde + LOTE);

        yield "insert into " +
          identificador(tabla) +
          " (" +
          columnas.map(identificador).join(", ") +
          ") values\n";

        yield lote
          .map(
            (fila) =>
              "  (" +
              columnas
                .map((columna) => literal(fila[columna], tipos.get(tabla)?.get(columna)))
                .join(", ") +
              ")",
          )
          .join(",\n");

        yield "\non conflict do nothing;" + SEPARADOR;
      }
    }

    yield "commit;" + SEPARADOR;
  }

  await pipeline(Readable.from(lineas()), createGzip({ level: 9 }), createWriteStream(archivo));

  const info = await stat(archivo);
  return { archivo, bytes: info.size, filas, tablas };
}

/**
 * Borra las copias más viejas y deja las últimas `CONSERVAR`.
 *
 * Sin esto la carpeta crece para siempre, y un disco lleno se convierte en el
 * problema que la copia venía a evitar.
 */
export async function podarCopias(carpeta: string): Promise<number> {
  let entradas: string[];

  try {
    entradas = await readdir(carpeta);
  } catch {
    return 0;
  }

  // El nombre lleva la fecha ISO, así que el orden alfabético ES el cronológico.
  const copias = entradas.filter((n) => n.startsWith("imperio-") && n.endsWith(".sql.gz")).sort();

  const sobran = copias.slice(0, Math.max(0, copias.length - CONSERVAR));
  for (const vieja of sobran) {
    await unlink(path.join(carpeta, vieja)).catch(() => undefined);
  }

  return sobran.length;
}

async function main(): Promise<void> {
  const carpeta = process.argv[2] ?? path.resolve(process.cwd(), "copias");

  const resultado = await crearCopia(carpeta);
  const borradas = await podarCopias(carpeta);

  console.log("\n" + "=".repeat(64));
  console.log("  COPIA DE SEGURIDAD");
  console.log("=".repeat(64));
  console.log("  archivo:  " + resultado.archivo);
  console.log("  tamaño:   " + (resultado.bytes / 1024).toFixed(1) + " KB");
  console.log("  filas:    " + resultado.filas);
  console.log("-".repeat(64));

  for (const [tabla, cuenta] of Object.entries(resultado.tablas)) {
    if (cuenta > 0) console.log("  " + tabla.padEnd(24) + String(cuenta).padStart(7));
  }

  if (borradas > 0) console.log("-".repeat(64) + "\n  copias viejas borradas: " + borradas);
  console.log("=".repeat(64) + "\n");
}

// Sólo corre como script; importarlo desde el bot no dispara nada.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/backup.ts")) {
  main()
    .catch((error) => {
      logger.error("Falló la copia de seguridad", { error });
      process.exitCode = 1;
    })
    .finally(closeDatabase);
}

export { TABLAS };
