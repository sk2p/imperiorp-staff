import crypto from "node:crypto";

import { getEnv } from "@/lib/core/env";

/**
 * IMPERIO RP — Almacenamiento de contraseñas.
 *
 * No hay criptografía propia acá. Se componen dos primitivas estándar de
 * `node:crypto`, exactamente como recomiendan OWASP y el RFC 7914:
 *
 *   1. PEPPER — HMAC-SHA256(contraseña, SESSION_SECRET). El secreto vive en el
 *      entorno, no en la base. Quien robe un dump de PostgreSQL no puede
 *      siquiera empezar a probar contraseñas sin tener también el servidor.
 *   2. KDF — scrypt con parámetros de la categoría recomendada por OWASP
 *      (N=2^16, r=8, p=2 → 64 MiB de memoria por intento). El costo en memoria
 *      es lo que hace inviable el ataque con GPU o ASIC.
 *
 * El hash es autodescriptivo: incluye su versión y sus parámetros, así que
 * subir el costo en el futuro no invalida las contraseñas existentes.
 *
 * Formato:  scrypt$v=2$N=65536,r=8,p=2$<salt_hex>$<clave_hex>
 */

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const CURRENT_VERSION = 2;

interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** Parámetros vigentes. Categoría OWASP: N=2^16, r=8, p=2. */
const CURRENT_PARAMS: ScryptParams = { N: 65_536, r: 8, p: 2 };

/**
 * Los tests ejecutan cientos de hashes; con los parámetros de producción
 * tardarían minutos. El costo bajo sólo aplica con NODE_ENV=test.
 */
const TEST_PARAMS: ScryptParams = { N: 1_024, r: 8, p: 1 };

function activeParams(): ScryptParams {
  return getEnv().NODE_ENV === "test" ? TEST_PARAMS : CURRENT_PARAMS;
}

/** scrypt necesita memoria ≈ 128·N·r. Se otorga el doble para no fallar al límite. */
function maxmemFor(params: ScryptParams): number {
  return 256 * params.N * params.r + 1024 * 1024;
}

function applyPepper(password: string): Buffer {
  return crypto.createHmac("sha256", getEnv().SESSION_SECRET).update(password, "utf8").digest();
}

function deriveKey(peppered: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      peppered,
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const params = activeParams();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const derived = await deriveKey(applyPepper(password), salt, params);

  return [
    "scrypt",
    "v=" + CURRENT_VERSION,
    "N=" + params.N + ",r=" + params.r + ",p=" + params.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

interface ParsedHash {
  readonly version: number;
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");

  // Formato actual: scrypt$v=2$N=...,r=...,p=...$salt$key
  if (parts.length === 5 && parts[0] === "scrypt") {
    const version = Number(parts[1]?.replace("v=", ""));
    const params = parseParams(parts[2]);
    if (!Number.isFinite(version) || !params || !parts[3] || !parts[4]) return null;
    return {
      version,
      params,
      salt: Buffer.from(parts[3], "hex"),
      key: Buffer.from(parts[4], "hex"),
    };
  }

  // Formato heredado (v1, sin pepper): scrypt$N=...,r=...,p=...$salt$key
  if (parts.length === 4 && parts[0] === "scrypt") {
    const params = parseParams(parts[1]);
    if (!params || !parts[2] || !parts[3]) return null;
    return {
      version: 1,
      params,
      salt: Buffer.from(parts[2], "hex"),
      key: Buffer.from(parts[3], "hex"),
    };
  }

  return null;
}

function parseParams(raw: string | undefined): ScryptParams | null {
  if (!raw) return null;
  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(raw);
  if (!match?.[1] || !match[2] || !match[3]) return null;

  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  // Límites defensivos: un hash manipulado no debe poder pedir 100 GB de RAM.
  if (params.N < 1024 || params.N > 1_048_576 || params.r > 32 || params.p > 16) return null;
  return params;
}

export interface PasswordVerification {
  readonly valid: boolean;
  /** El hash usa parámetros viejos: conviene regenerarlo tras un login exitoso. */
  readonly needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<PasswordVerification> {
  const parsed = parseHash(storedHash);
  if (!parsed) return { valid: false, needsRehash: false };

  try {
    // v1 no llevaba pepper. Se acepta para no dejar afuera a los usuarios
    // creados por la versión anterior, y se marca para migrar en el acto.
    const input = parsed.version >= 2 ? applyPepper(password) : Buffer.from(password, "utf8");
    const derived = await deriveKey(input, parsed.salt, parsed.params);

    if (derived.length !== parsed.key.length) return { valid: false, needsRehash: false };

    const valid = crypto.timingSafeEqual(derived, parsed.key);
    const current = activeParams();
    const needsRehash =
      valid &&
      (parsed.version < CURRENT_VERSION ||
        parsed.params.N !== current.N ||
        parsed.params.r !== current.r ||
        parsed.params.p !== current.p);

    return { valid, needsRehash };
  } catch {
    return { valid: false, needsRehash: false };
  }
}

/**
 * Consume el mismo tiempo que una verificación real.
 *
 * Se ejecuta cuando el usuario no existe, de modo que un atacante no pueda
 * distinguir "usuario inexistente" de "contraseña incorrecta" midiendo el
 * tiempo de respuesta. Sin esto, el login es un oráculo de enumeración.
 */
export async function fakeVerifyPassword(): Promise<void> {
  const params = activeParams();
  await deriveKey(applyPepper("contraseña-inexistente"), Buffer.alloc(SALT_LENGTH), params);
}

/* -------------------------------------------------------------------------- */
/* Calidad de la contraseña                                                    */
/* -------------------------------------------------------------------------- */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Contraseñas que aparecen en cualquier diccionario de ataque. Se rechazan
 * directamente, sin importar que cumplan los requisitos de forma.
 */
const BANNED = new Set([
  "password",
  "contrasena",
  "contraseña",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "administrador",
  "imperiorp",
  "imperio123",
  "staffimperio",
]);

export interface PasswordStrength {
  readonly valid: boolean;
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly label: string;
  readonly problems: readonly string[];
}

export function evaluatePassword(password: string, username?: string): PasswordStrength {
  const problems: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push("Debe tener al menos " + MIN_PASSWORD_LENGTH + " caracteres.");
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push("No puede superar los " + MAX_PASSWORD_LENGTH + " caracteres.");
  }
  if (!/[a-z]/.test(password)) problems.push("Debe incluir al menos una minúscula.");
  if (!/[A-Z]/.test(password)) problems.push("Debe incluir al menos una mayúscula.");
  if (!/\d/.test(password)) problems.push("Debe incluir al menos un número.");

  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (BANNED.has(normalized)) {
    problems.push("Es una contraseña demasiado común. Elegí otra.");
  }
  if (username && username.length >= 3 && normalized.includes(username.toLowerCase())) {
    problems.push("No puede contener el nombre de usuario.");
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push("No puede ser un único carácter repetido.");
  }

  let score = 0;
  if (password.length >= MIN_PASSWORD_LENGTH) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) score += 1;
  if (/[^a-zA-Z0-9]/.test(password)) score += 1;

  const boundedScore = Math.min(4, problems.length > 0 ? Math.min(score, 1) : score) as
    0 | 1 | 2 | 3 | 4;
  const labels = ["Muy débil", "Débil", "Aceptable", "Fuerte", "Muy fuerte"] as const;

  return {
    valid: problems.length === 0,
    score: boundedScore,
    label: labels[boundedScore] ?? "Muy débil",
    problems,
  };
}

/** Contraseña temporal legible, para cuando un OWNER restablece una cuenta. */
export function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const alphabet = upper + lower + digits + symbols;

  const pick = (source: string): string => {
    const index = crypto.randomInt(0, source.length);
    return source.charAt(index);
  };

  const required = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 10 }, () => pick(alphabet));
  const characters = [...required, ...rest];

  // Mezcla Fisher-Yates con una fuente de azar criptográfica.
  for (let i = characters.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    const a = characters[i];
    const b = characters[j];
    if (a !== undefined && b !== undefined) {
      characters[i] = b;
      characters[j] = a;
    }
  }

  return characters.join("");
}
