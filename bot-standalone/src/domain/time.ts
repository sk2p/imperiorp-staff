/**
 * IMPERIO RP — Representación de tiempo trabajado.
 *
 * El tiempo se guarda SIEMPRE como minutos enteros. Nunca como horas decimales:
 * 18,5 no es representable de forma exacta en binario, 1110 sí.
 */

/** Minutos enteros trabajados. */
export type Minutes = number;

/** Tope por entrada individual: un turno no puede durar más de 24 horas. */
export const MAX_MINUTES_PER_ENTRY = 24 * 60;

/**
 * Tope semanal por persona antes de pedir confirmación explícita.
 * 168 h son las horas de una semana entera: superarlo es físicamente imposible.
 */
export const MAX_MINUTES_PER_WEEK = 168 * 60;

/** Umbral a partir del cual la UI advierte "¿seguro?" sin bloquear. */
export const SUSPICIOUS_MINUTES_PER_ENTRY = 16 * 60;

export interface HoursAndMinutes {
  readonly hours: number;
  readonly minutes: number;
}

export function splitMinutes(totalMinutes: Minutes): HoursAndMinutes {
  const safe = Math.max(0, Math.trunc(totalMinutes || 0));
  return { hours: Math.floor(safe / 60), minutes: safe % 60 };
}

export function toMinutes(hours: number, minutes = 0): Minutes {
  const safeHours = Math.trunc(hours || 0);
  const safeMinutes = Math.trunc(minutes || 0);
  return safeHours * 60 + safeMinutes;
}

/** "18h 30m" · "4h" · "45m" · "0h" */
export function formatMinutes(totalMinutes: Minutes): string {
  const { hours, minutes } = splitMinutes(totalMinutes);
  if (hours === 0 && minutes === 0) return "0h";
  if (hours === 0) return minutes + "m";
  if (minutes === 0) return hours + "h";
  return hours + "h " + minutes + "m";
}

/** "18:30" — formato compacto para tablas densas y exportaciones. */
export function formatMinutesClock(totalMinutes: Minutes): string {
  const { hours, minutes } = splitMinutes(totalMinutes);
  return String(hours) + ":" + String(minutes).padStart(2, "0");
}

/**
 * Horas decimales. SÓLO para mostrar o graficar, jamás para calcular dinero.
 */
export function toDecimalHours(totalMinutes: Minutes, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((totalMinutes / 60) * factor) / factor;
}

/**
 * Interpreta lo que escribe una persona con la mayor cantidad de formatos
 * razonables: "2h 30m", "2:30", "2.5h", "150m", "2,5", "90".
 *
 * Un número suelto se interpreta como HORAS, que es lo que la gente espera al
 * escribir "8" en un campo llamado "horas".
 */
export function parseDurationInput(raw: string): Minutes | null {
  const input = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (input.length === 0) return null;

  // "2:30" o "18:05"
  const clock = /^(\d{1,4}):([0-5]?\d)$/.exec(input);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }

  // "2h30m", "2h 30", "2h"
  const composite = /^(\d{1,4})h(?:(\d{1,2})m?)?$/.exec(input);
  if (composite?.[1] !== undefined) {
    const hours = Number(composite[1]);
    const minutes = composite[2] !== undefined ? Number(composite[2]) : 0;
    if (minutes > 59) return null;
    return hours * 60 + minutes;
  }

  // "150m"
  const onlyMinutes = /^(\d{1,6})m$/.exec(input);
  if (onlyMinutes?.[1] !== undefined) {
    return Number(onlyMinutes[1]);
  }

  // "2.5h" o "2,5h" o "2,5"
  const decimal = /^(\d{1,4})[.,](\d{1,2})h?$/.exec(input);
  if (decimal?.[1] !== undefined && decimal[2] !== undefined) {
    const whole = Number(decimal[1]);
    const fraction = Number("0." + decimal[2]);
    return Math.round(whole * 60 + fraction * 60);
  }

  // Número suelto -> horas enteras
  const plain = /^(\d{1,4})$/.exec(input);
  if (plain?.[1] !== undefined) {
    return Number(plain[1]) * 60;
  }

  return null;
}

export interface DurationValidation {
  readonly valid: boolean;
  /** Bloquea el guardado. */
  readonly error?: string;
  /** No bloquea, pero exige confirmación consciente del usuario. */
  readonly warning?: string;
}

/** Prevención de errores humanos al cargar una entrada de horas. */
export function validateEntryMinutes(totalMinutes: Minutes): DurationValidation {
  if (!Number.isInteger(totalMinutes)) {
    return { valid: false, error: "La duración debe ser un número entero de minutos." };
  }
  if (totalMinutes <= 0) {
    return { valid: false, error: "La duración tiene que ser mayor a cero." };
  }
  if (totalMinutes > MAX_MINUTES_PER_ENTRY) {
    return {
      valid: false,
      error:
        "Un turno no puede superar las 24 horas (" +
        formatMinutes(totalMinutes) +
        "). Si abarca varios días, cargá una entrada por día.",
    };
  }
  if (totalMinutes > SUSPICIOUS_MINUTES_PER_ENTRY) {
    return {
      valid: true,
      warning:
        "Estás cargando " +
        formatMinutes(totalMinutes) +
        " en un solo turno. Confirmá que es correcto.",
    };
  }
  return { valid: true };
}
