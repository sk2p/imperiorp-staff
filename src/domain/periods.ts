/**
 * IMPERIO RP — Períodos de liquidación.
 *
 * Un período NO es necesariamente una semana de lunes a domingo. Imperio RP
 * define sus propios límites (por ejemplo 01/09 → 08/09) y el sistema los
 * respeta literalmente.
 *
 * Las fechas de un período se manejan como cadenas `YYYY-MM-DD` puras. No son
 * instantes: son días de calendario. Tratarlas como `Date` introduciría
 * corrimientos de un día al cruzar zonas horarias, que es exactamente el error
 * que este módulo existe para evitar.
 */

export const WEEK_STATUSES = ["open", "closed"] as const;
export type WeekStatus = (typeof WEEK_STATUSES)[number];

export function isWeekStatus(value: unknown): value is WeekStatus {
  return typeof value === "string" && (WEEK_STATUSES as readonly string[]).includes(value);
}

/** Una fecha de calendario en formato ISO corto, sin hora ni zona. */
export type CalendarDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Convierte una fecha de calendario al mediodía UTC: inmune a cambios de día. */
export function calendarDateToUtc(date: CalendarDate): Date {
  return new Date(date + "T12:00:00.000Z");
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const base = calendarDateToUtc(date);
  base.setUTCDate(base.getUTCDate() + days);
  return toCalendarDate(base);
}

export function toCalendarDate(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}

/** Diferencia en días entre dos fechas de calendario (fin − inicio). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  const millis = calendarDateToUtc(to).getTime() - calendarDateToUtc(from).getTime();
  return Math.round(millis / 86_400_000);
}

/** Cantidad de días que abarca el período, contando ambos extremos. */
export function periodLengthInDays(startDate: CalendarDate, endDate: CalendarDate): number {
  return daysBetween(startDate, endDate) + 1;
}

/** Lista todos los días del período, de inicio a fin inclusive. */
export function eachDayOfPeriod(
  startDate: CalendarDate,
  endDate: CalendarDate,
): readonly CalendarDate[] {
  const days: CalendarDate[] = [];
  const total = periodLengthInDays(startDate, endDate);
  for (let index = 0; index < total && index < 400; index += 1) {
    days.push(addDays(startDate, index));
  }
  return days;
}

export function isDateWithinPeriod(
  date: CalendarDate,
  startDate: CalendarDate,
  endDate: CalendarDate,
): boolean {
  return date >= startDate && date <= endDate;
}

/* -------------------------------------------------------------------------- */
/* Solapamiento                                                                */
/* -------------------------------------------------------------------------- */

export interface PeriodRange {
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
}

/**
 * Dos períodos se solapan si comparten al menos un día.
 * Se usa para impedir que se creen liquidaciones pisadas, que harían imposible
 * decidir a qué período pertenece una hora cargada.
 */
export function periodsOverlap(a: PeriodRange, b: PeriodRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

export function findOverlapping<T extends PeriodRange>(
  candidate: PeriodRange,
  existing: readonly T[],
): T | undefined {
  return existing.find((period) => periodsOverlap(candidate, period));
}

/* -------------------------------------------------------------------------- */
/* Presentación                                                                */
/* -------------------------------------------------------------------------- */

/** "01/09/2026" */
export function formatCalendarDate(date: CalendarDate): string {
  const [year, month, day] = date.split("-");
  return day + "/" + month + "/" + year;
}

/** "01/09" — versión corta para tablas densas. */
export function formatCalendarDateShort(date: CalendarDate): string {
  const [, month, day] = date.split("-");
  return day + "/" + month;
}

/** "01/09/2026 → 08/09/2026" — la etiqueta canónica de un período. */
export function formatPeriodLabel(startDate: CalendarDate, endDate: CalendarDate): string {
  return formatCalendarDate(startDate) + " → " + formatCalendarDate(endDate);
}

const WEEKDAYS = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
] as const;
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export function weekdayName(date: CalendarDate): string {
  return WEEKDAYS[calendarDateToUtc(date).getUTCDay()] ?? "";
}

/** "lunes 1 de septiembre" */
export function formatCalendarDateLong(date: CalendarDate): string {
  const instant = calendarDateToUtc(date);
  const month = MONTHS[instant.getUTCMonth()] ?? "";
  return weekdayName(date) + " " + instant.getUTCDate() + " de " + month;
}

export function monthKey(date: CalendarDate): string {
  return date.slice(0, 7);
}

/** "septiembre 2026" */
export function formatMonthKey(key: string): string {
  const [year, month] = key.split("-");
  const index = Number(month) - 1;
  return (MONTHS[index] ?? month ?? "") + " " + (year ?? "");
}

/* -------------------------------------------------------------------------- */
/* Validación y sugerencias                                                    */
/* -------------------------------------------------------------------------- */

export const MAX_PERIOD_DAYS = 62;

export interface PeriodValidation {
  readonly valid: boolean;
  readonly error?: string;
  readonly warning?: string;
}

export function validatePeriodRange(
  startDate: string,
  endDate: string,
  options: { readonly today?: CalendarDate } = {},
): PeriodValidation {
  if (!isCalendarDate(startDate)) {
    return { valid: false, error: "La fecha de inicio no es una fecha válida." };
  }
  if (!isCalendarDate(endDate)) {
    return { valid: false, error: "La fecha de fin no es una fecha válida." };
  }
  if (startDate > endDate) {
    return { valid: false, error: "La fecha de inicio no puede ser posterior a la de fin." };
  }

  const length = periodLengthInDays(startDate, endDate);
  if (length > MAX_PERIOD_DAYS) {
    return {
      valid: false,
      error:
        "El período abarca " +
        length +
        " días. El máximo admitido es " +
        MAX_PERIOD_DAYS +
        " para que las liquidaciones sigan siendo manejables.",
    };
  }

  const today = options.today;
  if (today && startDate > today) {
    const distance = daysBetween(today, startDate);
    if (distance > 30) {
      return {
        valid: true,
        warning: "El período empieza dentro de " + distance + " días. Verificá las fechas.",
      };
    }
  }

  if (length > 14) {
    return {
      valid: true,
      warning: "El período abarca " + length + " días, más de lo habitual para una liquidación.",
    };
  }

  return { valid: true };
}

/**
 * Sugiere el próximo período a partir del último cerrado: arranca el día
 * siguiente y conserva exactamente la misma duración.
 */
export function suggestNextPeriod(previous: PeriodRange): PeriodRange {
  const length = periodLengthInDays(previous.startDate, previous.endDate);
  const startDate = addDays(previous.endDate, 1);
  return { startDate, endDate: addDays(startDate, length - 1) };
}

/** Código canónico y estable de un período. Único por rango de fechas. */
export function buildPeriodCode(startDate: CalendarDate, endDate: CalendarDate): string {
  return startDate + "_" + endDate;
}
