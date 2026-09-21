import type { CalendarDate } from "./periods";

/**
 * IMPERIO RP — El reloj, en hora de Argentina.
 *
 * Hasta acá el sistema resolvía "qué día es hoy" con `toISOString()`, que da la
 * fecha en UTC. Para una planilla que se carga a mano casi nunca importa; para
 * fichajes es fatal: a las 21:00 de Argentina, UTC ya pasó a mañana, así que un
 * turno de las 22 se anotaría el día siguiente, y los de viernes a la noche
 * caerían en la semana equivocada.
 *
 * Todo lo que tenga que ver con "qué día fue esto" pasa por acá.
 */

/** Zona operativa. Se lee del entorno una sola vez. */
function zone(): string {
  return process.env.APP_TIMEZONE ?? "America/Argentina/Buenos_Aires";
}

/**
 * Cuánto adelanta la hora local respecto de UTC en ese instante, en
 * milisegundos. Se calcula con `Intl` y no con una constante, para que un
 * cambio de huso o de horario de verano no lo invalide.
 */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");

  const comoUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour") % 24,
    value("minute"),
    value("second"),
  );

  return comoUtc - instant.getTime();
}

/** La fecha del calendario local en ese instante: "2026-09-12". */
export function localDate(instant: Date = new Date(), timeZone = zone()): CalendarDate {
  // `en-CA` da exactamente el formato ISO que usa el resto del sistema.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** La hora local en ese instante: "22:47". */
export function localTime(instant: Date = new Date(), timeZone = zone()): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

/** Fecha y hora local, para los registros: "12/09/2026 22:47". */
export function localDateTime(instant: Date = new Date(), timeZone = zone()): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone,
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

/**
 * El instante exacto en que empieza ese día local.
 *
 * Se corrige una vez porque en un cambio de horario el desfase del mediodía no
 * es el de la medianoche. Sin esa corrección, dos veces al año el corte del día
 * quedaría una hora movido.
 */
export function startOfLocalDay(date: CalendarDate, timeZone = zone()): Date {
  const tentativo = new Date(date + "T00:00:00Z");
  const desfase = offsetMs(tentativo, timeZone);
  const primera = new Date(tentativo.getTime() - desfase);

  const desfaseReal = offsetMs(primera, timeZone);
  return desfaseReal === desfase ? primera : new Date(tentativo.getTime() - desfaseReal);
}

/** El día local siguiente. */
export function nextLocalDate(date: CalendarDate): CalendarDate {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** El día local anterior. */
export function previousLocalDate(date: CalendarDate): CalendarDate {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface DaySegment {
  readonly workDate: CalendarDate;
  readonly from: Date;
  readonly to: Date;
  readonly seconds: number;
}

/**
 * Parte un fichaje por las medianoches locales que atraviese.
 *
 * Un turno de 22:00 a 02:00 no son cuatro horas de un día: son dos de cada uno.
 * Y si esa medianoche además es la del sábado, son dos horas de una liquidación
 * y dos de la siguiente. Sumarlo todo al día de inicio daría una semana inflada
 * y la otra corta, así que se corta donde corresponde.
 *
 * Devuelve vacío si el rango no tiene duración.
 */
export function splitByLocalDay(start: Date, end: Date, timeZone = zone()): readonly DaySegment[] {
  if (end.getTime() <= start.getTime()) return [];

  const segmentos: DaySegment[] = [];
  let cursor = start;
  // Tope de seguridad: un fichaje jamás debería cruzar tantos días, pero un
  // bucle infinito acá dejaría el bot colgado.
  let vueltas = 0;

  while (cursor.getTime() < end.getTime() && vueltas < 40) {
    vueltas += 1;

    const dia = localDate(cursor, timeZone);
    const siguienteMedianoche = startOfLocalDay(nextLocalDate(dia), timeZone);
    const corte = siguienteMedianoche.getTime() < end.getTime() ? siguienteMedianoche : end;

    const seconds = Math.round((corte.getTime() - cursor.getTime()) / 1000);
    if (seconds > 0) segmentos.push({ workDate: dia, from: cursor, to: corte, seconds });

    cursor = corte;
  }

  return segmentos;
}

/**
 * Duración larga, como la muestran los registros de fichaje: "1h 48m 53s".
 * Se incluyen los segundos porque un fichaje es un tiempo medido, no una cifra
 * cargada a mano, y verlo al segundo es lo que da confianza en el número.
 */
export function formatDuration(totalSeconds: number): string {
  const seguros = Math.max(0, Math.round(totalSeconds));
  const horas = Math.floor(seguros / 3600);
  const minutos = Math.floor((seguros % 3600) / 60);
  const segundos = seguros % 60;

  if (horas > 0) return horas + "h " + minutos + "m " + segundos + "s";
  if (minutos > 0) return minutos + "m " + segundos + "s";
  return segundos + "s";
}

/** Los segundos, pasados a los minutos enteros con que se liquida. */
export function secondsToMinutes(totalSeconds: number): number {
  return Math.round(Math.max(0, totalSeconds) / 60);
}

/**
 * Fecha local corta, para las tablas: "12/09/2026".
 *
 * Existe por el mismo motivo que las otras: `toLocaleDateString("es-AR")` sin
 * zona horaria usa la del PROCESO, y en Vercel el proceso corre en UTC. Un
 * pago hecho a las 21:30 de Argentina aparecía con la fecha del día siguiente,
 * y nadie tenía forma de saber por qué.
 */
export function localDateShort(instant: Date, timeZone = zone()): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(instant);
}

/** Día y mes en letras, para los encabezados: "sábado 12 de septiembre". */
export function localDateLong(instant: Date, timeZone = zone()): string {
  return new Intl.DateTimeFormat("es-AR", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(instant);
}
