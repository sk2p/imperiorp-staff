import crypto from "node:crypto";
import { cookies } from "next/headers";

import { getEnv } from "@/lib/core/env";

/**
 * IMPERIO RP — Navegadores conocidos: el bloqueo de una cuenta no deja afuera
 * a su dueño.
 *
 * Cinco contraseñas mal bloquean la cuenta quince minutos, vengan de donde
 * vengan. Eso frena a quien reparte intentos entre muchas IP, pero convierte
 * al bloqueo en un arma: con saber un nombre de usuario —y los de quienes
 * administran se nombran en Discord— cualquiera puede dejar afuera al Fundador
 * cuando quiera, desde su casa, sin adivinar nada.
 *
 * La defensa es la que recomienda OWASP para ese problema ("device cookies"):
 * al entrar bien, el navegador se lleva una marca firmada con el secreto del
 * servidor. Con la cuenta bloqueada, un intento SIN esa marca se rechaza como
 * siempre; CON ella, se deja probar la contraseña. Quien ataca no la tiene: no
 * la puede leer —es HttpOnly— ni fabricar —no tiene el secreto—.
 *
 * La marca sola no abre nada: sin la contraseña no sirve. Y lleva la fecha del
 * último cambio de contraseña, así que cambiarla o restablecerla invalida
 * todas las marcas anteriores.
 */

export const DEVICE_COOKIE = "imperio_dispositivo";

/** Seis meses: es para el navegador de siempre, no para una sesión. */
const DURACION_SEGUNDOS = 180 * 24 * 60 * 60;

export interface CuentaMarcable {
  readonly id: string;
  readonly passwordChangedAt: Date | null;
}

export function marcaDeDispositivo(cuenta: CuentaMarcable): string {
  const firma = crypto
    .createHmac("sha256", getEnv().SESSION_SECRET)
    .update("dispositivo:v1:" + cuenta.id + ":" + (cuenta.passwordChangedAt?.getTime() ?? 0))
    .digest("base64url");

  return cuenta.id + "." + firma;
}

export function esMarcaValida(valor: string | null | undefined, cuenta: CuentaMarcable): boolean {
  if (typeof valor !== "string" || valor.length === 0) return false;

  const esperada = Buffer.from(marcaDeDispositivo(cuenta));
  const recibida = Buffer.from(valor);

  // Largos distintos ya es "no coincide"; `timingSafeEqual` exige el mismo.
  if (esperada.length !== recibida.length) return false;
  return crypto.timingSafeEqual(esperada, recibida);
}

export async function leerMarcaDeDispositivo(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(DEVICE_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export async function recordarDispositivo(cuenta: CuentaMarcable): Promise<void> {
  const env = getEnv();
  const store = await cookies();

  store.set(DEVICE_COOKIE, marcaDeDispositivo(cuenta), {
    httpOnly: true,
    secure: env.NODE_ENV === "production" || env.APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: DURACION_SEGUNDOS,
  });
}
