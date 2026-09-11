import { divideRoundHalfUp, toSafeNumber, type MoneyUnits } from "./money";
import { formatMinutes, type Minutes } from "./time";

/**
 * IMPERIO RP — Motor de liquidación.
 *
 * Fórmula:   importe = redondeo_half_up( minutos × tarifa_por_hora / 60 )
 *
 * Se multiplica ANTES de dividir y todo ocurre en `bigint`, de modo que el
 * resultado es exacto y no depende del orden de las operaciones ni del hardware.
 *
 * PUNTO IMPORTANTE: el importe se calcula sobre el TOTAL de minutos de la
 * semana, nunca sumando los importes de cada entrada. Redondear una sola vez al
 * final evita que se acumulen diferencias de hasta un peso por entrada cargada.
 */

const MINUTES_PER_HOUR = 60n;

/**
 * Calcula cuánto corresponde cobrar por una cantidad de minutos a una tarifa horaria.
 *
 * @param totalMinutes minutos enteros trabajados
 * @param hourlyRate   tarifa por hora en unidades enteras de moneda
 */
export function calculateEarnings(totalMinutes: Minutes, hourlyRate: MoneyUnits): MoneyUnits {
  if (!Number.isFinite(totalMinutes) || !Number.isFinite(hourlyRate)) return 0;

  const minutes = BigInt(Math.trunc(totalMinutes));
  const rate = BigInt(Math.trunc(hourlyRate));

  if (minutes <= 0n || rate <= 0n) return 0;

  return toSafeNumber(divideRoundHalfUp(minutes * rate, MINUTES_PER_HOUR));
}

/**
 * Operación inversa: cuántos minutos explican un importe dado. Se usa para
 * verificar liquidaciones históricas y detectar inconsistencias.
 */
export function minutesForEarnings(amount: MoneyUnits, hourlyRate: MoneyUnits): Minutes {
  if (hourlyRate <= 0) return 0;
  const result = divideRoundHalfUp(
    BigInt(Math.trunc(amount)) * MINUTES_PER_HOUR,
    BigInt(Math.trunc(hourlyRate)),
  );
  return Number(result);
}

export interface PayrollLine {
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly hourlyRate: MoneyUnits;
  readonly totalMinutes: Minutes;
  readonly amount: MoneyUnits;
}

export interface PayrollTotals {
  readonly totalMinutes: Minutes;
  readonly totalAmount: MoneyUnits;
  readonly memberCount: number;
  /** Miembros con al menos un minuto cargado. */
  readonly activeMemberCount: number;
  readonly averageMinutes: Minutes;
}

/**
 * Construye una línea de liquidación. Es la única función autorizada a producir
 * el importe de un miembro dentro de una semana.
 */
export function buildPayrollLine(input: {
  staffMemberId: string;
  name: string;
  rank: string;
  hourlyRate: MoneyUnits;
  totalMinutes: Minutes;
}): PayrollLine {
  return {
    staffMemberId: input.staffMemberId,
    name: input.name,
    rank: input.rank,
    hourlyRate: input.hourlyRate,
    totalMinutes: input.totalMinutes,
    amount: calculateEarnings(input.totalMinutes, input.hourlyRate),
  };
}

export function summarizePayroll(lines: readonly PayrollLine[]): PayrollTotals {
  let totalMinutes = 0;
  let totalAmount = 0n;
  let activeMemberCount = 0;

  for (const line of lines) {
    totalMinutes += line.totalMinutes;
    totalAmount += BigInt(Math.trunc(line.amount));
    if (line.totalMinutes > 0) activeMemberCount += 1;
  }

  return {
    totalMinutes,
    totalAmount: toSafeNumber(totalAmount),
    memberCount: lines.length,
    activeMemberCount,
    averageMinutes: activeMemberCount === 0 ? 0 : Math.round(totalMinutes / activeMemberCount),
  };
}

/**
 * Explicación legible de cómo se llegó a un importe. Se muestra en el detalle de
 * liquidación para que cualquiera pueda auditar el número a mano.
 */
export function explainCalculation(
  totalMinutes: Minutes,
  hourlyRate: MoneyUnits,
): {
  readonly formatted: string;
  readonly minutes: Minutes;
  readonly rate: MoneyUnits;
  readonly amount: MoneyUnits;
} {
  const amount = calculateEarnings(totalMinutes, hourlyRate);
  return {
    formatted:
      formatMinutes(totalMinutes) +
      " = " +
      totalMinutes +
      " min → (" +
      totalMinutes +
      " × " +
      hourlyRate.toLocaleString("es-AR") +
      ") ÷ 60",
    minutes: totalMinutes,
    rate: hourlyRate,
    amount,
  };
}

/* -------------------------------------------------------------------------- */
/* Compatibilidad con el módulo anterior                                       */
/* -------------------------------------------------------------------------- */

export { formatMinutes, splitMinutes, toMinutes } from "./time";
export { formatMoney as formatCurrency } from "./money";
