/**
 * IMPERIO RP — Aritmética monetaria.
 *
 * REGLA INNEGOCIABLE: el dinero jamás se representa con `number` en coma
 * flotante durante un cálculo. Toda operación intermedia usa `bigint` sobre
 * unidades enteras de la moneda del servidor; recién el resultado final,
 * verificado contra `Number.MAX_SAFE_INTEGER`, se convierte a `number` para
 * poder viajar por JSON y guardarse en un `bigint` de PostgreSQL.
 *
 * POLÍTICA DE REDONDEO: media unidad hacia arriba (half-up). Es la política
 * habitual en liquidaciones y la única que no perjudica sistemáticamente al
 * empleado. Está implementada con enteros, por lo que es exacta y reproducible
 * en cualquier máquina.
 */

/** Cantidad de dinero en unidades enteras. Nunca decimales. */
export type MoneyUnits = number;

/**
 * Techo defensivo. Muy por debajo de `Number.MAX_SAFE_INTEGER` (9.007e15) para
 * que incluso las sumas históricas acumuladas sigan siendo exactas.
 */
export const MAX_MONEY_UNITS = 1_000_000_000_000_000; // 1e15

export class MoneyOverflowError extends Error {
  constructor(value: bigint) {
    super(
      "El importe calculado (" +
        value.toString() +
        ") supera el máximo representable con exactitud. Revisá las horas y la tarifa cargadas.",
    );
    this.name = "MoneyOverflowError";
  }
}

/**
 * Convierte un `bigint` a `number` verificando que no se pierda precisión.
 * Este es el único punto del sistema donde el dinero cambia de representación.
 */
export function toSafeNumber(value: bigint): MoneyUnits {
  if (value > BigInt(MAX_MONEY_UNITS) || value < -BigInt(MAX_MONEY_UNITS)) {
    throw new MoneyOverflowError(value);
  }
  return Number(value);
}

/**
 * División entera con redondeo half-up, exacta para numeradores no negativos.
 *
 * `(n + d/2) / d` con división entera equivale a redondear .5 hacia arriba.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error("División por cero en el cálculo monetario.");
  }
  if (denominator < 0n) {
    return divideRoundHalfUp(-numerator, -denominator);
  }
  if (numerator >= 0n) {
    return (numerator * 2n + denominator) / (denominator * 2n);
  }
  // Simétrico para negativos: -0.5 redondea hacia -1 (alejándose de cero).
  return -((-numerator * 2n + denominator) / (denominator * 2n));
}

/** Suma una lista de importes sin riesgo de desbordar. */
export function sumMoney(amounts: readonly MoneyUnits[]): MoneyUnits {
  let total = 0n;
  for (const amount of amounts) {
    total += BigInt(Math.trunc(amount));
  }
  return toSafeNumber(total);
}

/**
 * Valida que un valor sea un importe aceptable: entero, finito y dentro de rango.
 */
export function isValidMoney(value: unknown): value is MoneyUnits {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Math.abs(value) <= MAX_MONEY_UNITS
  );
}

/* -------------------------------------------------------------------------- */
/* Presentación                                                               */
/* -------------------------------------------------------------------------- */

const GROUPED = new Intl.NumberFormat("es-AR", {
  useGrouping: true,
  maximumFractionDigits: 0,
});

/** "$27.750.000" */
export function formatMoney(amount: MoneyUnits): string {
  return "$" + GROUPED.format(Math.trunc(amount));
}

/** "27.750.000" sin símbolo, para tablas y exportaciones. */
export function formatMoneyPlain(amount: MoneyUnits): string {
  return GROUPED.format(Math.trunc(amount));
}

/**
 * Forma compacta para tarjetas de métricas: "$27,7 M", "$1,4 MM".
 * Sólo para lectura rápida; los importes exactos siempre se muestran completos.
 */
export function formatMoneyCompact(amount: MoneyUnits): string {
  const value = Math.trunc(amount);
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  const scale = (divisor: number, suffix: string): string => {
    const scaled = value / divisor;
    const decimals = Math.abs(scaled) >= 100 ? 0 : 1;
    return (
      sign +
      "$" +
      new Intl.NumberFormat("es-AR", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(Math.abs(scaled)) +
      " " +
      suffix
    );
  };

  if (abs >= 1_000_000_000_000) return scale(1_000_000_000_000, "B");
  if (abs >= 1_000_000_000) return scale(1_000_000_000, "MM");
  if (abs >= 1_000_000) return scale(1_000_000, "M");
  if (abs >= 1_000) return scale(1_000, "K");
  return sign + "$" + GROUPED.format(abs);
}

/**
 * Interpreta lo que escribe una persona: "1.500.000", "1500000", "1,5M", "$ 2.000.000".
 * Devuelve `null` si no hay una lectura inequívoca.
 */
export function parseMoneyInput(raw: string): MoneyUnits | null {
  const trimmed = raw
    .trim()
    .replace(/^\$\s*/, "")
    .replace(/\s/g, "");
  if (trimmed.length === 0) return null;

  const multiplierMatch = /^([\d.,]+)(k|m|mm|b)$/i.exec(trimmed);
  const numericPart = multiplierMatch?.[1] ?? trimmed;
  const suffix = multiplierMatch?.[2]?.toLowerCase();

  if (!/^[\d.,]+$/.test(numericPart)) return null;

  // Normaliza el formato es-AR: el punto separa miles, la coma decimales.
  const normalized = numericPart.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  const multiplier =
    suffix === "k"
      ? 1_000
      : suffix === "m"
        ? 1_000_000
        : suffix === "mm"
          ? 1_000_000_000
          : suffix === "b"
            ? 1_000_000_000_000
            : 1;

  const result = Math.round(parsed * multiplier);
  return isValidMoney(result) ? result : null;
}
