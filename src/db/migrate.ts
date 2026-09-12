import { sql } from "drizzle-orm";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";

import { closeDatabase, databaseDriver, db } from "@/db";
import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";
import { ensureRankRates, ensureSettings } from "@/server/settings";

/**
 * Aplica las migraciones versionadas y siembra las filas de referencia
 * (tarifas por rango y configuración). Idempotente: correrlo dos veces no
 * cambia nada.
 */
export async function runMigrations(): Promise<void> {
  const folder = path.resolve(process.cwd(), "drizzle");
  logger.info("Aplicando migraciones", { driver: databaseDriver(), folder });

  await migrateNodePg(db, { migrationsFolder: folder });

  await ensureRankRates();
  await ensureSettings();

  logger.info("Migraciones aplicadas y datos de referencia verificados");
}

const isDirectRun = process.argv[1]?.includes("migrate");

if (isDirectRun) {
  getEnv();
  runMigrations()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error("Fallaron las migraciones", { error });
      process.exit(1);
    });
}

/**
 * Cuántas migraciones hay escritas y cuántas aplicó esta base.
 *
 * Drizzle guarda una fila por migración en `drizzle.__drizzle_migrations`.
 * Comparar esa cuenta contra los archivos del journal alcanza para saber si el
 * esquema está al día, sin pedir permisos especiales ni exponer nada.
 */
export async function pendingMigrations(): Promise<{ applied: number; pending: number }> {
  const journalPath = path.join(process.cwd(), "drizzle", "meta", "_journal.json");

  let total = 0;
  try {
    const { readFile } = await import("node:fs/promises");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries?: readonly unknown[];
    };
    total = journal.entries?.length ?? 0;
  } catch {
    // Sin journal no hay nada que comparar: se informa cero y no se falla.
    return { applied: 0, pending: 0 };
  }

  try {
    const result = await db.execute(
      sql`select count(*)::int as aplicadas from drizzle.__drizzle_migrations`,
    );
    const applied = Number(result.rows[0]?.aplicadas ?? 0);
    return { applied, pending: Math.max(0, total - applied) };
  } catch {
    // La tabla no existe: ninguna migración corrió todavía.
    return { applied: 0, pending: total };
  }
}
