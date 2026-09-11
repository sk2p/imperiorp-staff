import crypto from "node:crypto";

import { getEnv } from "./env";

/**
 * Huella corta del SESSION_SECRET.
 *
 * El secreto es el pepper con el que se derivan los hashes de contraseña: si el
 * servidor arranca con uno distinto al que se usó para crear las cuentas,
 * ninguna contraseña funciona y el error que ve el usuario es simplemente
 * "usuario o contraseña incorrectos", que no da ninguna pista.
 *
 * Publicar 8 caracteres de un SHA-256 no permite reconstruir el secreto, pero
 * sí permite comparar dos entornos de un vistazo.
 */
export function secretFingerprint(): string {
  return crypto
    .createHash("sha256")
    .update("fingerprint:" + getEnv().SESSION_SECRET)
    .digest("hex")
    .slice(0, 8);
}
