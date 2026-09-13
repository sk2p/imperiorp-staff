import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { esMarcaValida, leerMarcaDeDispositivo, recordarDispositivo } from "@/lib/auth/dispositivo";
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
import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";
import { avisarNavegadorNuevo } from "./aviso-de-acceso";
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
 *
 * Probado contra una base real en `tests/seguridad-acceso.test.ts` y
 * `tests/aviso-acceso.test.ts`.
 */
const GENERIC_ERROR = "Usuario o contraseña incorrectos.";
export interface LoginOutcome {
  readonly userId: string;
  readonly username: string;
  readonly mustChangePassword: boolean;
}
export async function performLogin(
  input: { username: string; password: string },
  metadata: { ip: string; userAgent: string | undefined; lugar?: string | undefined },
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
  /**
   * Bloqueo por CUENTA, además del que ya hay por IP.
   *
   * El límite por IP frena a quien prueba mil contraseñas desde una máquina;
   * no frena a quien reparte los intentos entre muchas IP contra la misma
   * cuenta, que es exactamente como se ataca una cuenta concreta. Este
   * contador no mira de dónde viene el intento, sólo a quién apunta.
   *
   * Se responde con el mismo error genérico y sin decir que la cuenta está
   * bloqueada: confirmar el bloqueo ya sería confirmar que la cuenta existe.
   * Por lo mismo, el rechazo gasta lo que gasta verificar una contraseña: si
   * contestara al instante, lo rápido de la respuesta lo delataría.
   *
   * La excepción es el navegador donde el dueño ya entró antes. Sin ella el
   * bloqueo es un arma: con saber el nombre de usuario, cualquiera deja afuera
   * a quien quiera. Ver `lib/auth/dispositivo.ts`.
   */
  const ahora = Date.now();
  const bloqueada = user.lockedUntil !== null && user.lockedUntil.getTime() > ahora;
  // Decide dos cosas: si este navegador pasa un bloqueo, y si al entrar hay que avisar.
  const navegadorConocido = esMarcaValida(await leerMarcaDeDispositivo(), user);
  if (bloqueada && !navegadorConocido) {
    await fakeVerifyPassword();
    await recordSecurityEvent({
      type: "LOGIN_BLOCKED",
      userId: user.id,
      username: user.username,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      details: {
        reason: "cuenta bloqueada por intentos fallidos",
        hasta: user.lockedUntil?.toISOString(),
      },
    });
    throw unauthenticated(GENERIC_ERROR);
  }

  const check = await verifyPassword(input.password, user.passwordHash);
  if (!check.valid) {
    await registerFailedLogin(metadata.ip, username);

    /**
     * Un bloqueo vencido no deja la cuenta cargada.
     *
     * El contador de fallos sólo volvía a cero al entrar bien. Pasados los
     * quince minutos la cuenta seguía con cinco fallos anotados, y el sexto
     * —uno solo— la volvía a bloquear otros quince: para tener a alguien
     * afuera para siempre bastaba un intento cada cuarto de hora. Ahora, al
     * vencer el bloqueo, la cuenta arranca de cero y hay que juntar cinco
     * otra vez.
     */
    const bloqueoVencido = user.lockedUntil !== null && user.lockedUntil.getTime() <= ahora;
    const fallos = (bloqueoVencido ? 0 : user.failedLoginCount) + 1;
    const env = getEnv();
    const bloquear = fallos >= env.MAX_LOGIN_ATTEMPTS;

    await db
      .update(users)
      .set({
        failedLoginCount: fallos,
        ...(bloquear
          ? { lockedUntil: new Date(ahora + env.LOGIN_LOCKOUT_WINDOW_MINUTES * 60 * 1000) }
          : bloqueoVencido
            ? { lockedUntil: null }
            : {}),
      })
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
  // Este navegador pasa a ser conocido: un bloqueo futuro no lo deja afuera.
  await recordarDispositivo(user);

  /**
   * Entró desde un navegador que esta cuenta no conocía: se le avisa al dueño
   * por privado, con navegador, lugar e IP. Si fue él, lo ignora; si no, sabe
   * que alguien tiene su contraseña y dónde cortar la sesión.
   *
   * Sale en segundo plano: el acceso no espera a Discord ni falla por él.
   */
  if (!navegadorConocido) {
    avisarNavegadorNuevo({
      userId: user.id,
      username: user.username,
      ip: metadata.ip,
      userAgent: metadata.userAgent ?? null,
      lugar: metadata.lugar ?? null,
      cuando: new Date(ahora),
    });
  }

  await recordSecurityEvent({
    type: "LOGIN_SUCCESS",
    userId: user.id,
    username: user.username,
    ip: metadata.ip,
    userAgent: metadata.userAgent,
    details: {
      role: user.role,
      hashActualizado: Boolean(rehash),
      ...(navegadorConocido ? {} : { navegadorNuevo: true }),
      // Entró su dueño mientras alguien más tenía la cuenta bloqueada: vale mirarlo.
      ...(bloqueada ? { conCuentaBloqueada: true } : {}),
    },
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
