import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { fakeVerifyPassword, hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  registerFailedLogin,
} from "@/lib/auth/rate-limit";
import {
  clearSessionCookie,
  createSession,
  readSessionCookie,
  revokeSession,
  setSessionCookie,
} from "@/lib/auth/session";
import { rateLimited, unauthenticated } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";
import { recordSecurityEvent } from "./security-events";
/**
 * Flujo de acceso.
 *
 * Decisiones de seguridad deliberadas:
 *  · El mensaje de error es SIEMPRE el mismo, exista o no el usuario.
 *  · Si el usuario no existe se ejecuta igualmente un hash falso, para que el
 *    tiempo de respuesta no revele qué cuentas son reales.
 *  · El límite de intentos se consulta ANTES de tocar la contraseña.
 *  · La sesión se crea recién después de validar, con un token nuevo: no hay
 *    forma de fijar una sesión de antemano.
 */
const GENERIC_ERROR = "Usuario o contraseña incorrectos.";
export interface LoginOutcome {
  readonly userId: string;
  readonly username: string;
  readonly mustChangePassword: boolean;
}
export async function performLogin(
  input: { username: string; password: string },
  metadata: { ip: string; userAgent: string | undefined },
): Promise<LoginOutcome> {
  const username = input.username.trim().toLowerCase();
  const limit = await checkLoginRateLimit(metadata.ip, username);
  if (!limit.allowed) {
    await recordSecurityEvent({
      type: "LOGIN_BLOCKED",
      username,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      details: { retryAfterSeconds: limit.retryAfterSeconds },
    });
    throw rateLimited(
      "Demasiados intentos fallidos. Volvé a probar en " +
        Math.ceil(limit.retryAfterSeconds / 60) +
        " minuto(s).",
      limit.retryAfterSeconds,
    );
  }
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${username}`)
    .limit(1);
  if (!user) {
    // Mismo costo computacional que una verificación real.
    await fakeVerifyPassword();
    await registerFailedLogin(metadata.ip, username);
    await recordSecurityEvent({
      type: "LOGIN_FAILED",
      username,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      details: { reason: "usuario inexistente" },
    });
    throw unauthenticated(GENERIC_ERROR);
  }
  const check = await verifyPassword(input.password, user.passwordHash);
  if (!check.valid) {
    await registerFailedLogin(metadata.ip, username);
    await db
      .update(users)
      .set({ failedLoginCount: user.failedLoginCount + 1 })
      .where(eq(users.id, user.id));
    await recordSecurityEvent({
      type: "LOGIN_FAILED",
      userId: user.id,
      username: user.username,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      details: { reason: "contraseña incorrecta" },
    });
    throw unauthenticated(GENERIC_ERROR);
  }
  // Una cuenta desactivada devuelve el mismo error genérico: no se confirma
  // siquiera que la cuenta exista.
  if (!user.active) {
    await recordSecurityEvent({
      type: "LOGIN_FAILED",
      userId: user.id,
      username: user.username,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      details: { reason: "cuenta desactivada" },
    });
    throw unauthenticated(GENERIC_ERROR);
  }
  await clearLoginAttempts(metadata.ip, username);
  // Migración transparente del hash si quedó con parámetros viejos.
  const rehash = check.needsRehash ? await hashPassword(input.password) : null;
  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
      lastLoginIp: metadata.ip.slice(0, 45),
      failedLoginCount: 0,
      lockedUntil: null,
      ...(rehash ? { passwordHash: rehash } : {}),
    })
    .where(eq(users.id, user.id));
  const { rawToken } = await createSession(user.id, metadata);
  await setSessionCookie(rawToken);
  await recordSecurityEvent({
    type: "LOGIN_SUCCESS",
    userId: user.id,
    username: user.username,
    ip: metadata.ip,
    userAgent: metadata.userAgent,
    details: { role: user.role, hashActualizado: Boolean(rehash) },
  });
  logger.info("Acceso correcto", { username: user.username, role: user.role });
  return {
    userId: user.id,
    username: user.username,
    mustChangePassword: user.mustChangePassword,
  };
}
export async function performLogout(metadata: { ip?: string; username?: string }): Promise<void> {
  const rawToken = await readSessionCookie();
  if (rawToken) await revokeSession(rawToken, "Cierre de sesión del usuario");
  await clearSessionCookie();
  await recordSecurityEvent({
    type: "LOGOUT",
    username: metadata.username ?? null,
    ip: metadata.ip ?? null,
  });
}
