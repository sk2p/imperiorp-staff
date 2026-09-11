import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import crypto from "node:crypto";

import { db, type Executor } from "@/db";
import { sessions, users, type Session, type User } from "@/db/schema";
import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";

/**
 * IMPERIO RP — Sesiones con estado en base de datos.
 *
 * Se eligió sesión con estado (y no un JWT) por una razón concreta: un JWT no
 * se puede revocar. Acá, expulsar a un usuario comprometido es un UPDATE que
 * surte efecto en el siguiente request.
 *
 * Defensas incorporadas:
 *   · En la base sólo vive el SHA-256 del token; un dump no permite suplantar a nadie.
 *   · Doble vencimiento: deslizante por inactividad y absoluto e inamovible.
 *   · Fijación de sesión imposible: el token se genera DESPUÉS de validar la
 *     contraseña y nunca se reutiliza uno preexistente.
 *   · La cookie es HttpOnly, por lo que ningún script de la página puede leerla.
 */

export const SESSION_COOKIE = "imperio_session";

/** Tras este tiempo sin actividad, la sesión caduca. */
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 horas

/** La sesión se renueva sólo si pasó este tiempo, para no escribir en cada request. */
const RENEW_THRESHOLD_MS = 15 * 60 * 1000;

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface SessionContext {
  readonly user: User;
  readonly session: Session;
}

export interface SessionMetadata {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Ciclo de vida                                                              */
/* -------------------------------------------------------------------------- */

export async function createSession(
  userId: string,
  metadata: SessionMetadata = {},
  executor: Executor = db,
): Promise<{ rawToken: string; session: Session }> {
  const env = getEnv();
  const rawToken = generateSessionToken();
  const now = Date.now();

  const [session] = await executor
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(rawToken),
      ip: metadata.ip?.slice(0, 45),
      userAgent: metadata.userAgent?.slice(0, 512),
      expiresAt: new Date(now + IDLE_TIMEOUT_MS),
      absoluteExpiresAt: new Date(now + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(now),
    })
    .returning();

  if (!session) {
    throw new Error("No se pudo crear la sesión en la base de datos.");
  }

  return { rawToken, session };
}

/**
 * Valida un token y devuelve el usuario. Renueva la ventana de inactividad
 * cuando corresponde, sin sobrepasar nunca el vencimiento absoluto.
 */
export async function validateSessionToken(rawToken: string): Promise<SessionContext | null> {
  if (typeof rawToken !== "string" || rawToken.length < 20) return null;

  const now = new Date();
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(rawToken)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Una cuenta desactivada pierde el acceso de inmediato, sin esperar a que
  // venza la sesión.
  if (!row.user.active) {
    await revokeSession(rawToken, "Cuenta desactivada");
    return null;
  }

  const shouldRenew = now.getTime() - row.session.lastSeenAt.getTime() > RENEW_THRESHOLD_MS;
  if (!shouldRenew) return { user: row.user, session: row.session };

  const renewedExpiry = new Date(
    Math.min(now.getTime() + IDLE_TIMEOUT_MS, row.session.absoluteExpiresAt.getTime()),
  );

  const [renewed] = await db
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt: renewedExpiry })
    .where(eq(sessions.id, row.session.id))
    .returning();

  return { user: row.user, session: renewed ?? row.session };
}

export async function revokeSession(
  rawToken: string,
  reason: string,
  revokedBy?: string,
): Promise<void> {
  if (!rawToken) return;
  await db
    .update(sessions)
    .set({
      revokedAt: new Date(),
      revokeReason: reason.slice(0, 120),
      ...(revokedBy ? { revokedBy } : {}),
    })
    .where(and(eq(sessions.tokenHash, hashToken(rawToken)), isNull(sessions.revokedAt)));
}

export async function revokeSessionById(
  sessionId: string,
  reason: string,
  revokedBy?: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({
      revokedAt: new Date(),
      revokeReason: reason.slice(0, 120),
      ...(revokedBy ? { revokedBy } : {}),
    })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/**
 * Cierra todas las sesiones de un usuario. Se llama al cambiar la contraseña,
 * al desactivar la cuenta y cuando un OWNER expulsa a alguien.
 */
export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  options: { readonly exceptSessionId?: string; readonly revokedBy?: string } = {},
  executor: Executor = db,
): Promise<number> {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  if (options.exceptSessionId) {
    conditions.push(sql`${sessions.id} <> ${options.exceptSessionId}`);
  }

  const revoked = await executor
    .update(sessions)
    .set({
      revokedAt: new Date(),
      revokeReason: reason.slice(0, 120),
      ...(options.revokedBy ? { revokedBy: options.revokedBy } : {}),
    })
    .where(and(...conditions))
    .returning({ id: sessions.id });

  return revoked.length;
}

export async function listActiveSessions(userId: string): Promise<Session[]> {
  const now = new Date();
  return db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)),
    )
    .orderBy(sql`${sessions.lastSeenAt} desc`);
}

/** Borra sesiones muertas. Lo llama el endpoint de mantenimiento. */
export async function purgeExpiredSessions(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(sessions)
    .where(or(lt(sessions.absoluteExpiresAt, cutoff), lt(sessions.revokedAt, cutoff)))
    .returning({ id: sessions.id });

  if (deleted.length > 0) {
    logger.info("Sesiones vencidas purgadas", { count: deleted.length });
  }
  return deleted.length;
}

/* -------------------------------------------------------------------------- */
/* Cookie                                                                     */
/* -------------------------------------------------------------------------- */

function cookieOptions(maxAgeSeconds: number) {
  const env = getEnv();
  const secure = env.NODE_ENV === "production" || env.APP_URL.startsWith("https://");

  return {
    httpOnly: true,
    secure,
    // `lax` permite volver al panel desde un enlace externo sin perder la sesión.
    // La defensa contra CSRF no descansa en esto, sino en la validación de
    // origen y el token de doble envío (ver `csrf.ts`).
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function setSessionCookie(rawToken: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, rawToken, cookieOptions(getEnv().SESSION_TTL_DAYS * 24 * 60 * 60));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", cookieOptions(0));
}

export async function readSessionCookie(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/** Sesión actual a partir de la cookie del request. `null` si no hay o no vale. */
export async function getCurrentSession(): Promise<SessionContext | null> {
  const rawToken = await readSessionCookie();
  if (!rawToken) return null;
  return validateSessionToken(rawToken);
}
