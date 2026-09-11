import { and, eq, isNotNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { loginAttempts } from "@/db/schema";
import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";

/**
 * IMPERIO RP — Límite de intentos, persistido en PostgreSQL.
 *
 * Un contador en memoria se borra al reiniciar el proceso y no se comparte
 * entre instancias: bastaría con esperar un redeploy, o repartir los intentos
 * entre réplicas, para saltearlo. Guardarlo en la base cierra las dos puertas.
 *
 * Se cuentan dos cubos a la vez:
 *   · ip + usuario  → frena el ataque dirigido contra una cuenta concreta.
 *   · ip            → frena el rociado de contraseñas contra muchas cuentas.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remainingAttempts: number;
  readonly retryAfterSeconds: number;
  readonly lockedUntil?: Date;
}

function limits() {
  const env = getEnv();
  return {
    maxAttempts: env.MAX_LOGIN_ATTEMPTS,
    windowMs: env.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000,
  };
}

/** El cubo por IP tolera más intentos: varias personas pueden compartir salida. */
const IP_BUCKET_MULTIPLIER = 4;

export function accountBucket(ip: string, username: string): string {
  return "acct:" + ip + ":" + username.trim().toLowerCase();
}

export function ipBucket(ip: string): string {
  return "ip:" + ip;
}

async function readBucket(bucketKey: string) {
  const rows = await db
    .select()
    .from(loginAttempts)
    .where(eq(loginAttempts.bucketKey, bucketKey))
    .limit(1);
  return rows[0] ?? null;
}

async function evaluateBucket(bucketKey: string, maxAttempts: number): Promise<RateLimitDecision> {
  const { windowMs } = limits();
  const record = await readBucket(bucketKey);
  const now = Date.now();

  if (!record) {
    return { allowed: true, remainingAttempts: maxAttempts, retryAfterSeconds: 0 };
  }

  if (record.lockedUntil && record.lockedUntil.getTime() > now) {
    return {
      allowed: false,
      remainingAttempts: 0,
      retryAfterSeconds: Math.ceil((record.lockedUntil.getTime() - now) / 1000),
      lockedUntil: record.lockedUntil,
    };
  }

  // La ventana venció: el contador arranca de cero en el próximo intento.
  if (now - record.firstAttemptAt.getTime() > windowMs) {
    return { allowed: true, remainingAttempts: maxAttempts, retryAfterSeconds: 0 };
  }

  return {
    allowed: record.attempts < maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - record.attempts),
    retryAfterSeconds: 0,
  };
}

/** Consulta sin consumir intentos. Se llama antes de tocar la contraseña. */
export async function checkLoginRateLimit(
  ip: string,
  username: string,
): Promise<RateLimitDecision> {
  const { maxAttempts } = limits();

  const [account, address] = await Promise.all([
    evaluateBucket(accountBucket(ip, username), maxAttempts),
    evaluateBucket(ipBucket(ip), maxAttempts * IP_BUCKET_MULTIPLIER),
  ]);

  // Gana el cubo más restrictivo.
  if (!account.allowed) return account;
  if (!address.allowed) return address;

  return {
    allowed: true,
    remainingAttempts: Math.min(account.remainingAttempts, address.remainingAttempts),
    retryAfterSeconds: 0,
  };
}

async function bumpBucket(bucketKey: string, maxAttempts: number): Promise<RateLimitDecision> {
  const { windowMs } = limits();
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);

  /**
   * Un único statement atómico: inserta o incrementa, reinicia la ventana si
   * venció y aplica el bloqueo al llegar al tope. Hacerlo en varias consultas
   * abriría una carrera que permitiría superar el límite con peticiones
   * simultáneas.
   *
   * Los `::timestamptz` no son decorativos: dentro de un `case … else null`,
   * PostgreSQL no tiene de dónde deducir el tipo del parámetro y lo asume
   * `text`, con lo que la asignación a una columna de fecha falla con el error
   * 42804. El cast le da el tipo explícitamente.
   */
  const lockedUntil = new Date(now.getTime() + windowMs);

  const [record] = await db
    .insert(loginAttempts)
    .values({ bucketKey, attempts: 1, firstAttemptAt: now, lastAttemptAt: now })
    .onConflictDoUpdate({
      target: loginAttempts.bucketKey,
      set: {
        attempts: sql`case
          when ${loginAttempts.firstAttemptAt} < ${windowStart}::timestamptz then 1
          else ${loginAttempts.attempts} + 1
        end`,
        firstAttemptAt: sql`case
          when ${loginAttempts.firstAttemptAt} < ${windowStart}::timestamptz then ${now}::timestamptz
          else ${loginAttempts.firstAttemptAt}
        end`,
        lastAttemptAt: now,
        lockedUntil: sql`case
          when ${loginAttempts.firstAttemptAt} >= ${windowStart}::timestamptz
           and ${loginAttempts.attempts} + 1 >= ${maxAttempts}
          then ${lockedUntil}::timestamptz
          else null
        end`,
      },
    })
    .returning();

  if (!record) {
    return { allowed: true, remainingAttempts: maxAttempts - 1, retryAfterSeconds: 0 };
  }

  if (record.lockedUntil && record.lockedUntil.getTime() > now.getTime()) {
    return {
      allowed: false,
      remainingAttempts: 0,
      retryAfterSeconds: Math.ceil((record.lockedUntil.getTime() - now.getTime()) / 1000),
      lockedUntil: record.lockedUntil,
    };
  }

  return {
    allowed: true,
    remainingAttempts: Math.max(0, maxAttempts - record.attempts),
    retryAfterSeconds: 0,
  };
}

export async function registerFailedLogin(
  ip: string,
  username: string,
): Promise<RateLimitDecision> {
  const { maxAttempts } = limits();

  const [account, address] = await Promise.all([
    bumpBucket(accountBucket(ip, username), maxAttempts),
    bumpBucket(ipBucket(ip), maxAttempts * IP_BUCKET_MULTIPLIER),
  ]);

  if (!account.allowed) return account;
  if (!address.allowed) return address;

  return {
    allowed: true,
    remainingAttempts: Math.min(account.remainingAttempts, address.remainingAttempts),
    retryAfterSeconds: 0,
  };
}

/** Un acceso correcto limpia el cubo de la cuenta, no el de la IP. */
export async function clearLoginAttempts(ip: string, username: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.bucketKey, accountBucket(ip, username)));
}

/** Desbloqueo manual desde la pantalla de seguridad. */
export async function releaseLock(bucketKey: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.bucketKey, bucketKey));
}

export async function listActiveLocks(): Promise<
  { bucketKey: string; attempts: number; lockedUntil: Date | null }[]
> {
  const now = new Date();
  return db
    .select({
      bucketKey: loginAttempts.bucketKey,
      attempts: loginAttempts.attempts,
      lockedUntil: loginAttempts.lockedUntil,
    })
    .from(loginAttempts)
    .where(and(isNotNull(loginAttempts.lockedUntil), sql`${loginAttempts.lockedUntil} > ${now}`))
    .orderBy(sql`${loginAttempts.lockedUntil} desc`)
    .limit(100);
}

/** Limpieza de cubos vencidos. La ejecuta el endpoint de mantenimiento. */
export async function purgeStaleAttempts(): Promise<number> {
  const { windowMs } = limits();
  const cutoff = new Date(Date.now() - windowMs * 4);

  const deleted = await db
    .delete(loginAttempts)
    .where(
      and(
        lt(loginAttempts.lastAttemptAt, cutoff),
        or(sql`${loginAttempts.lockedUntil} is null`, lt(loginAttempts.lockedUntil, new Date())),
      ),
    )
    .returning({ id: loginAttempts.id });

  if (deleted.length > 0) {
    logger.debug("Cubos de intentos purgados", { count: deleted.length });
  }
  return deleted.length;
}
