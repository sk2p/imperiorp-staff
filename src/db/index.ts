import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import path from "node:path";
import pg from "pg";

import { getEnv } from "@/lib/core/env";
import { isTransientDatabaseError } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";
import * as schema from "./schema";

/**
 * IMPERIO RP — Acceso a datos.
 *
 * Dos motores, un solo tipo:
 *   · PostgreSQL real vía `pg` (producción y cualquier proveedor estándar).
 *   · PGlite embebido (desarrollo sin instalar nada, y tests aislados).
 *
 * El adaptador PGlite se normaliza al tipo de node-postgres en ESTE ÚNICO
 * punto del sistema. Es la diferencia entre una conversión deliberada y
 * documentada, y tipar la base como `any` — que desactivaría el chequeo de
 * tipos en todas las consultas de la aplicación.
 */

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

/** Contexto transaccional. Misma API que `Database`, sin `transaction` anidada. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Cualquier cosa capaz de ejecutar consultas. Todos los servicios reciben un
 * `Executor`, de modo que la misma función sirve suelta o dentro de una
 * transacción sin duplicar código.
 */
export type Executor = Database | Transaction;

/* -------------------------------------------------------------------------- */
/* Construcción del cliente                                                   */
/* -------------------------------------------------------------------------- */

interface DatabaseHandle {
  readonly db: Database;
  readonly driver: "postgres" | "pglite";
  readonly close: () => Promise<void>;
}

/**
 * En desarrollo, Next.js recarga los módulos en caliente. Sin este singleton
 * global se abriría un pool nuevo en cada recarga hasta agotar las conexiones.
 */
const globalRef = globalThis as typeof globalThis & {
  __imperioDb?: DatabaseHandle;
};

function shouldUseSsl(connectionString: string): boolean {
  const env = getEnv();
  if (env.DATABASE_SSL !== undefined) return env.DATABASE_SSL;
  if (/[?&]sslmode=disable/.test(connectionString)) return false;

  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal|db|postgres)[:/]/.test(
    connectionString,
  );
  return !isLocal;
}

function createHandle(): DatabaseHandle {
  const env = getEnv();
  const connectionString = env.DATABASE_URL;

  if (connectionString) {
    const pool = new pg.Pool({
      connectionString,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      /**
       * TLS con verificación completa del certificado.
       *
       * Sin verificar, la conexión va cifrada pero no autenticada: quien pueda
       * interponerse en la red presenta su propio certificado y lee —o
       * modifica— todo lo que viaja, que acá son horas, sueldos y contraseñas.
       *
       * Neon, Supabase, Railway y Render usan certificados de una autoridad
       * pública, así que esto funciona tal cual. `DATABASE_SSL_NO_VERIFY=true`
       * queda sólo para un PostgreSQL propio con certificado autofirmado.
       */
      ssl: shouldUseSsl(connectionString)
        ? { rejectUnauthorized: !env.DATABASE_SSL_NO_VERIFY }
        : undefined,
      application_name: "imperio-rp-staff",
    });

    pool.on("error", (error) => {
      logger.error("Error inesperado en el pool de PostgreSQL", { error });
    });

    return {
      db: drizzleNodePg(pool, { schema }),
      driver: "postgres",
      close: () => pool.end(),
    };
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL es obligatoria en producción. PGlite embebido no está permitido: " +
        "los datos se perderían al redeploy del contenedor.",
    );
  }

  // Tests: instancia en memoria, sin archivos ni bloqueos entre procesos.
  const client =
    env.NODE_ENV === "test"
      ? new PGlite()
      : new PGlite(path.resolve(process.cwd(), ".pglite_data"));

  if (env.NODE_ENV !== "test") {
    logger.warn(
      "DATABASE_URL no está definida: usando PGlite embebido en .pglite_data. " +
        "Sólo para desarrollo local.",
    );
  }

  const pgliteDb = drizzlePglite(client, { schema });

  return {
    // Normalización deliberada: PGlite es PostgreSQL real compilado a WASM y
    // expone la misma superficie de Drizzle que usa esta aplicación.
    db: pgliteDb as unknown as Database,
    driver: "pglite",
    close: () => client.close(),
  };
}

function handle(): DatabaseHandle {
  globalRef.__imperioDb ??= createHandle();
  return globalRef.__imperioDb;
}

export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(handle().db, property, receiver);
  },
  has(_target, property) {
    return Reflect.has(handle().db, property);
  },
});

export function databaseDriver(): "postgres" | "pglite" {
  return handle().driver;
}

export async function closeDatabase(): Promise<void> {
  const current = globalRef.__imperioDb;
  if (!current) return;
  globalRef.__imperioDb = undefined;
  await current.close();
}

/** Sólo para tests: descarta la instancia cacheada sin cerrarla. */
export function __resetDatabaseHandleForTests(): void {
  globalRef.__imperioDb = undefined;
}

/* -------------------------------------------------------------------------- */
/* Transacciones                                                              */
/* -------------------------------------------------------------------------- */

export interface TransactionOptions {
  /**
   * `serializable` para operaciones donde dos usuarios simultáneos podrían
   * producir un resultado incoherente (cerrar un período, registrar un pago).
   * PostgreSQL aborta una de las dos y el llamador reintenta.
   */
  readonly isolation?: "read committed" | "repeatable read" | "serializable";
}

/**
 * Ejecuta `fn` dentro de una transacción. Si lanza, se revierte TODO: nunca
 * queda la base en un estado a medio aplicar.
 */
export async function withTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  /**
   * Un reintento cuando la conexión se cortó, no cuando falló la operación.
   *
   * El plan gratuito de Neon duerme la base cuando nadie la usa, y la primera
   * consulta después de un rato puede encontrarse la conexión muerta mientras
   * el servidor despierta. Sin esto, a alguien del staff le aparecía un error
   * inesperado con un código de soporte por cargar dos horas un martes.
   *
   * Reintentar es seguro justamente porque es una TRANSACCIÓN: si la conexión
   * se corta, PostgreSQL la deshace entera. No hay forma de que una parte haya
   * quedado escrita y el reintento la duplique.
   */
  try {
    return await db.transaction(
      fn,
      options.isolation ? { isolationLevel: options.isolation } : undefined,
    );
  } catch (error) {
    if (!isTransientDatabaseError(error)) throw error;

    logger.warn("La base no respondió; reintentando una vez", {
      motivo: error instanceof Error ? error.message.slice(0, 120) : String(error),
    });

    // Medio segundo: lo que tarda Neon en levantar el servidor dormido.
    await new Promise((resolve) => setTimeout(resolve, 500));

    return db.transaction(
      fn,
      options.isolation ? { isolationLevel: options.isolation } : undefined,
    );
  }
}

/** Código de PostgreSQL para fallo de serialización (colisión de concurrencia). */
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

/**
 * Transacción serializable con reintento acotado.
 *
 * Bajo aislamiento `serializable`, PostgreSQL puede abortar una transacción que
 * compitió con otra. Es el comportamiento correcto y esperado: se reintenta con
 * una espera creciente en vez de propagar el error al usuario.
 */
export async function withSerializableTransaction<T>(
  fn: (tx: Transaction) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTransaction(fn, { isolation: "serializable" });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === maxAttempts) throw error;

      logger.warn("Conflicto de serialización: reintentando la transacción", {
        attempt,
        maxAttempts,
      });
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 25));
    }
  }

  throw lastError;
}

/* -------------------------------------------------------------------------- */
/* Diagnóstico                                                                */
/* -------------------------------------------------------------------------- */

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly driver: "postgres" | "pglite";
  readonly latencyMs: number;
  readonly error?: string;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
    return { ok: true, driver: databaseDriver(), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      driver: databaseDriver(),
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Error desconocido",
    };
  }
}

export { schema };
