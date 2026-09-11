import { describe, expect, it } from "vitest";

import { divideRoundHalfUp, formatMoney, parseMoneyInput, sumMoney } from "@/domain/money";
import { calculateEarnings, summarizePayroll } from "@/domain/payroll";
import { RANK_DEFINITIONS } from "@/domain/ranks";
import { formatMinutes, parseDurationInput, validateEntryMinutes } from "@/domain/time";

const SOPORTE = 1_000_000;
const MODERACION = 1_500_000;
const ADMIN = 2_000_000;

describe("cálculo de la liquidación", () => {
  it("resuelve el caso de referencia de Imperio RP", () => {
    // Martin, MOD, 18h 30m → 1110 minutos × $1.500.000 / 60
    expect(calculateEarnings(1110, MODERACION)).toBe(27_750_000);
  });

  it("devuelve cero cuando no hay horas o no hay tarifa", () => {
    expect(calculateEarnings(0, MODERACION)).toBe(0);
    expect(calculateEarnings(600, 0)).toBe(0);
    expect(calculateEarnings(-60, MODERACION)).toBe(0);
  });

  it("redondea medio hacia arriba, nunca en contra del empleado", () => {
    // 1 minuto a $1.000.000/h = 16.666,66… → 16.667
    expect(calculateEarnings(1, SOPORTE)).toBe(16_667);
    // 59 minutos = 983.333,33… → 983.333
    expect(calculateEarnings(59, SOPORTE)).toBe(983_333);
  });

  it("es exacto en los múltiplos de media hora", () => {
    expect(calculateEarnings(30, SOPORTE)).toBe(500_000);
    expect(calculateEarnings(60, SOPORTE)).toBe(1_000_000);
    expect(calculateEarnings(90, MODERACION)).toBe(2_250_000);
  });

  it("mantiene la exactitud con cantidades grandes", () => {
    // Un año entero de trabajo continuo al rango más alto.
    const minutes = 365 * 24 * 60;
    expect(calculateEarnings(minutes, ADMIN)).toBe(17_520_000_000);
  });

  it("no acumula error de coma flotante", () => {
    // El caso clásico: 0.1 + 0.2 !== 0.3 en binario. Acá todo es entero.
    const total = sumMoney([
      calculateEarnings(7, SOPORTE),
      calculateEarnings(13, SOPORTE),
      calculateEarnings(41, SOPORTE),
    ]);
    expect(Number.isInteger(total)).toBe(true);
  });

  it("da el mismo resultado sin importar el orden de la suma", () => {
    const lines = [
      { minutes: 137, rate: SOPORTE },
      { minutes: 991, rate: MODERACION },
      { minutes: 43, rate: ADMIN },
    ];
    const forward = sumMoney(lines.map((l) => calculateEarnings(l.minutes, l.rate)));
    const backward = sumMoney(
      [...lines].reverse().map((l) => calculateEarnings(l.minutes, l.rate)),
    );
    expect(forward).toBe(backward);
  });

  it("redondea una sola vez, sobre el total y no por entrada", () => {
    // Tres turnos de 1 minuto: redondear cada uno daría 50.001 en vez de 50.000.
    const perEntry = sumMoney([
      calculateEarnings(1, SOPORTE),
      calculateEarnings(1, SOPORTE),
      calculateEarnings(1, SOPORTE),
    ]);
    const onTotal = calculateEarnings(3, SOPORTE);

    expect(perEntry).toBe(50_001);
    expect(onTotal).toBe(50_000);
    // El sistema usa SIEMPRE el total: por eso se guarda `total_minutes`.
    expect(onTotal).toBeLessThan(perEntry);
  });

  it("aplica la tarifa correcta a cada rango oficial", () => {
    expect(calculateEarnings(60, RANK_DEFINITIONS.SDP.defaultRatePerHour)).toBe(1_000_000);
    expect(calculateEarnings(60, RANK_DEFINITIONS.SE.defaultRatePerHour)).toBe(1_000_000);
    expect(calculateEarnings(60, RANK_DEFINITIONS["MOD++"].defaultRatePerHour)).toBe(1_500_000);
    expect(calculateEarnings(60, RANK_DEFINITIONS["ADM++"].defaultRatePerHour)).toBe(2_000_000);
  });
});

describe("equivalencia entre el cálculo de TypeScript y el de PostgreSQL", () => {
  /**
   * La consulta que recalcula los snapshots usa
   * `(minutos * tarifa * 2 + 60) / 120` con enteros. Tiene que dar
   * exactamente lo mismo que `calculateEarnings`, o los totales que muestra la
   * pantalla no coincidirían con los que guarda la base.
   */
  const sqlFormula = (minutes: number, rate: number): number =>
    Number((BigInt(minutes) * BigInt(rate) * 2n + 60n) / 120n);

  it("coincide en miles de combinaciones", () => {
    const rates = [SOPORTE, MODERACION, ADMIN, 1, 7, 999_999];
    let checked = 0;

    for (const rate of rates) {
      for (let minutes = 0; minutes <= 600; minutes += 1) {
        expect(sqlFormula(minutes, rate)).toBe(calculateEarnings(minutes, rate));
        checked += 1;
      }
    }

    expect(checked).toBeGreaterThan(3_000);
  });
});

describe("división con redondeo half-up", () => {
  it("redondea .5 hacia arriba", () => {
    expect(divideRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divideRoundHalfUp(7n, 2n)).toBe(4n);
  });

  it("deja intactos los cocientes exactos", () => {
    expect(divideRoundHalfUp(10n, 5n)).toBe(2n);
    expect(divideRoundHalfUp(0n, 5n)).toBe(0n);
  });

  it("se aleja de cero con valores negativos", () => {
    expect(divideRoundHalfUp(-5n, 2n)).toBe(-3n);
  });

  it("rechaza la división por cero", () => {
    expect(() => divideRoundHalfUp(1n, 0n)).toThrow();
  });
});

describe("totales del período", () => {
  it("suma minutos e importes y cuenta sólo a quien trabajó", () => {
    const totals = summarizePayroll([
      {
        staffMemberId: "1",
        name: "Martin",
        rank: "MOD",
        hourlyRate: MODERACION,
        totalMinutes: 1110,
        amount: 27_750_000,
      },
      {
        staffMemberId: "2",
        name: "Lucas",
        rank: "SP",
        hourlyRate: SOPORTE,
        totalMinutes: 600,
        amount: 10_000_000,
      },
      {
        staffMemberId: "3",
        name: "Pedro",
        rank: "ADM",
        hourlyRate: ADMIN,
        totalMinutes: 0,
        amount: 0,
      },
    ]);

    expect(totals.totalMinutes).toBe(1710);
    expect(totals.totalAmount).toBe(37_750_000);
    expect(totals.memberCount).toBe(3);
    expect(totals.activeMemberCount).toBe(2);
    expect(totals.averageMinutes).toBe(855);
  });

  it("no divide por cero cuando nadie trabajó", () => {
    const totals = summarizePayroll([]);
    expect(totals.averageMinutes).toBe(0);
    expect(totals.totalAmount).toBe(0);
  });
});

describe("formato", () => {
  it("muestra el dinero al estilo argentino", () => {
    expect(formatMoney(27_750_000)).toBe("$27.750.000");
    expect(formatMoney(0)).toBe("$0");
  });

  it("muestra las duraciones de forma legible", () => {
    expect(formatMinutes(1110)).toBe("18h 30m");
    expect(formatMinutes(240)).toBe("4h");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(0)).toBe("0h");
  });
});

describe("interpretación de lo que escribe el usuario", () => {
  it("entiende los formatos habituales de duración", () => {
    expect(parseDurationInput("2h 30m")).toBe(150);
    expect(parseDurationInput("2:30")).toBe(150);
    expect(parseDurationInput("2.5h")).toBe(150);
    expect(parseDurationInput("2,5")).toBe(150);
    expect(parseDurationInput("150m")).toBe(150);
    expect(parseDurationInput("8")).toBe(480); // un número suelto son horas
  });

  it("rechaza lo que no puede interpretar sin ambigüedad", () => {
    expect(parseDurationInput("")).toBeNull();
    expect(parseDurationInput("un rato")).toBeNull();
    expect(parseDurationInput("2h 99m")).toBeNull();
  });

  it("entiende los formatos habituales de importe", () => {
    expect(parseMoneyInput("1.500.000")).toBe(1_500_000);
    expect(parseMoneyInput("1500000")).toBe(1_500_000);
    expect(parseMoneyInput("$ 2.000.000")).toBe(2_000_000);
    expect(parseMoneyInput("1,5M")).toBe(1_500_000);
    expect(parseMoneyInput("abc")).toBeNull();
  });
});

describe("prevención de errores humanos al cargar horas", () => {
  it("bloquea duraciones imposibles", () => {
    expect(validateEntryMinutes(0).valid).toBe(false);
    expect(validateEntryMinutes(-10).valid).toBe(false);
    // El caso "999 horas" del pedido original.
    expect(validateEntryMinutes(999 * 60).valid).toBe(false);
    expect(validateEntryMinutes(25 * 60).valid).toBe(false);
  });

  it("advierte sin bloquear ante un turno muy largo", () => {
    const result = validateEntryMinutes(20 * 60);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeDefined();
  });

  it("acepta un turno normal sin molestar", () => {
    const result = validateEntryMinutes(150);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});
