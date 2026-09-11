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
