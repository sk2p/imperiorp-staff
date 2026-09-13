/**
 * IMPERIO RP — Cuándo mirar y cuándo redibujar.
 *
 * La lógica del refresco en vivo, separada del componente para poder probarla
 * sin navegador. El componente está en `components/layout/live-refresh.tsx` y
 * la firma que compara, en `server/firma.ts`.
 */

/** Cada cuánto se pregunta si hay algo nuevo, con alguien usando la pantalla. */
export const INTERVALO_MS = 12_000;

/** Cada cuánto, si hace rato que nadie toca nada. */
export const INTERVALO_QUIETO_MS = 60_000;

/** Cuánto sin mouse ni teclado para considerar que la pantalla quedó sola. */
export const QUIETO_TRAS_MS = 5 * 60_000;

/**
 * Cada cuánto se redibuja igual, cambie la firma o no.
 *
 * Es la red por debajo de la firma. Lo que no es un dato guardado —el "hace
 * 5 min" de la actividad reciente— no la mueve, y así no queda más viejo que
 * un minuto.
 */
export const REFRESCO_COMPLETO_MS = 60_000;

/** ¿Pasó suficiente tiempo desde la última vez que se preguntó? */
export function tocaMirar(input: {
  readonly ahora: number;
  readonly ultimaMirada: number;
  readonly ultimaActividad: number;
}): boolean {
  const quieta = input.ahora - input.ultimaActividad >= QUIETO_TRAS_MS;
  const intervalo = quieta ? INTERVALO_QUIETO_MS : INTERVALO_MS;

  // Un cuarto de segundo de tolerancia: el temporizador del navegador nunca es
  // exacto, y sin esto un tic que llega a los 11,99 s se saltearía entero.
  return input.ahora - input.ultimaMirada >= intervalo - 250;
}

/** Con la firma del servidor en la mano, ¿vale la pena redibujar? */
export function hayQueRedibujar(input: {
  readonly firmaPantalla: string | null;
  readonly firmaServidor: string | null;
  readonly ahora: number;
  readonly ultimoRedibujo: number;
}): boolean {
  const desdeElUltimo = input.ahora - input.ultimoRedibujo;

  // Recién se redibujó: la pantalla nueva, con su firma, todavía viene en camino.
  if (desdeElUltimo < INTERVALO_MS) return false;

  if (desdeElUltimo >= REFRESCO_COMPLETO_MS) return true;

  // Sin firma del servidor —se cayó la red o la base— no se insiste: redibujar
  // tampoco funcionaría, y sólo sumaría pedidos contra lo que ya está fallando.
  if (input.firmaServidor === null) return false;

  return input.firmaServidor !== input.firmaPantalla;
}
