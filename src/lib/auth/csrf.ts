import crypto from "node:crypto";

import { getEnv } from "@/lib/core/env";
import { forbidden } from "@/lib/core/errors";

/**
 * IMPERIO RP — Defensa contra CSRF.
 *
 * Se aplican tres barreras independientes. Un atacante tiene que vencerlas a
 * todas, y ninguna depende de las otras:
 *
 *   1. ORIGEN — `Origin`/`Referer` deben coincidir con el host de la aplicación.
 *      Los navegadores mandan `Origin` en toda petición que no sea de lectura y
 *      no permiten falsificarlo desde JavaScript.
 *   2. TOKEN DE DOBLE ENVÍO — un valor derivado de la sesión con HMAC y el
 *      secreto del servidor. Un sitio de terceros no puede leerlo (lo impide la
 *      política de mismo origen) ni calcularlo (no tiene el secreto).
 *   3. COOKIE SameSite=Lax — evita el envío automático de la cookie en
 *      peticiones POST originadas en otro sitio.
 *
 * Las Server Actions de Next.js validan el origen por su cuenta; estas
 * funciones cubren los route handlers y agregan la segunda capa en todo caso.
 */

// Los nombres viven aparte porque también los usa el navegador, y este archivo
// importa `node:crypto`. Ver `csrf-campos.ts`.
export { CSRF_FIELD, CSRF_HEADER } from "./csrf-campos";

/**
 * Token determinista por sesión. Al derivarse del identificador de sesión con
 * una clave secreta, se invalida solo cuando la sesión termina y no requiere
 * almacenamiento adicional.
 */
export function csrfTokenFor(sessionId: string): string {
  return crypto
    .createHmac("sha256", getEnv().SESSION_SECRET)
    .update("csrf:v1:" + sessionId)
    .digest("base64url");
}

export function verifyCsrfToken(sessionId: string, candidate: string | null | undefined): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;

  const expected = Buffer.from(csrfTokenFor(sessionId));
  const received = Buffer.from(candidate);

  // La comparación en tiempo constante exige longitudes iguales; si difieren,
  // ya sabemos que no coinciden y no hay información temporal que filtrar.
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export function assertCsrfToken(sessionId: string, candidate: string | null | undefined): void {
  if (!verifyCsrfToken(sessionId, candidate)) {
    throw forbidden(
      "La verificación de seguridad de la petición falló. Recargá la página e intentá de nuevo.",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Validación de origen                                                       */
/* -------------------------------------------------------------------------- */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

export interface OriginCheckInput {
  readonly method: string;
  readonly origin: string | null;
  readonly referer: string | null;
  /** Host que reporta el propio request (`Host` o `X-Forwarded-Host`). */
  readonly host: string | null;
}

export function isSameOrigin(input: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;

  const allowed = new Set<string>();
  const configured = hostOf(getEnv().APP_URL);
  if (configured) allowed.add(configured);
  if (input.host) allowed.add(input.host.toLowerCase());

  const originHost = hostOf(input.origin);
  if (originHost) return allowed.has(originHost);

  // Algunos clientes omiten `Origin`; `Referer` sirve como respaldo.
  const refererHost = hostOf(input.referer);
  if (refererHost) return allowed.has(refererHost);

  // Sin ninguna de las dos cabeceras no se puede probar el origen. Para una
  // operación que modifica datos, la respuesta correcta es rechazar.
  return false;
}

export function assertSameOrigin(request: Request): void {
  const headers = request.headers;
  const ok = isSameOrigin({
    method: request.method,
    origin: headers.get("origin"),
    referer: headers.get("referer"),
    host: headers.get("x-forwarded-host") ?? headers.get("host"),
  });

  if (!ok) {
    throw forbidden("Petición rechazada: el origen no coincide con el de la aplicación.");
  }
}
