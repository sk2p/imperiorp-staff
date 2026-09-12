import { describe, expect, it } from "vitest";

import {
  formatDuration,
  localDate,
  nextLocalDate,
  previousLocalDate,
  secondsToMinutes,
  splitByLocalDay,
  startOfLocalDay,
} from "@/domain/clock";

/**
 * Lo único que este bot no puede equivocar es cuánto trabajó cada uno y en qué
 * día. Todo lo demás es presentación; esto es la plata del staff.
 */

const AR = "America/Argentina/Buenos_Aires";

describe("el día local, no el de UTC", () => {
  it("a las 22 de Argentina sigue siendo hoy, aunque en UTC ya sea mañana", () => {
    // 2026-09-12 22:30 en Argentina (UTC-3) es 2026-09-13 01:30 en UTC.
    const instante = new Date("2026-09-13T01:30:00Z");

    expect(instante.toISOString().slice(0, 10)).toBe("2026-09-13");
    expect(localDate(instante, AR)).toBe("2026-09-12");
  });

  it("a las 21 en punto todavía no cambió el día", () => {
    expect(localDate(new Date("2026-09-13T00:00:00Z"), AR)).toBe("2026-09-12");
  });

  it("pasada la medianoche local sí cambia", () => {
    expect(localDate(new Date("2026-09-13T03:00:01Z"), AR)).toBe("2026-09-13");
  });

  it("la medianoche local de un día es las 03:00 UTC", () => {
    expect(startOfLocalDay("2026-09-12", AR).toISOString()).toBe("2026-09-12T03:00:00.000Z");
  });

  it("avanza y retrocede días sin desbordar el mes", () => {
    expect(nextLocalDate("2026-09-30")).toBe("2026-10-01");
    expect(previousLocalDate("2026-10-01")).toBe("2026-09-30");
    expect(nextLocalDate("2026-12-31")).toBe("2027-01-01");
    // Año bisiesto.
    expect(nextLocalDate("2028-02-28")).toBe("2028-02-29");
  });
});

describe("repartir un fichaje por día", () => {
  it("un turno dentro del mismo día es un solo pedazo", () => {
    // 18:00 a 20:30 hora de Argentina.
    const partes = splitByLocalDay(
      new Date("2026-09-12T21:00:00Z"),
      new Date("2026-09-12T23:30:00Z"),
      AR,
    );

    expect(partes).toHaveLength(1);
    expect(partes[0]?.workDate).toBe("2026-09-12");
    expect(partes[0]?.seconds).toBe(2.5 * 3600);
  });

  it("un turno que cruza la medianoche se parte en dos días", () => {
    // 22:00 del 12 a 02:00 del 13, hora local.
    const partes = splitByLocalDay(
      new Date("2026-09-13T01:00:00Z"),
      new Date("2026-09-13T05:00:00Z"),
      AR,
    );

    expect(partes).toHaveLength(2);
    expect(partes[0]).toMatchObject({ workDate: "2026-09-12", seconds: 2 * 3600 });
    expect(partes[1]).toMatchObject({ workDate: "2026-09-13", seconds: 2 * 3600 });
  });

  it("no pierde ni inventa un solo segundo al partir", () => {
    const desde = new Date("2026-09-13T01:17:42Z");
    const hasta = new Date("2026-09-13T07:03:19Z");
    const total = Math.round((hasta.getTime() - desde.getTime()) / 1000);

    const partes = splitByLocalDay(desde, hasta, AR);
    const sumado = partes.reduce((suma, p) => suma + p.seconds, 0);

    expect(sumado).toBe(total);
  });

  it("un turno que cruza el sábado cae en dos liquidaciones distintas", () => {
    // 2026-09-12 es sábado: el período nuevo arranca ese día.
    const partes = splitByLocalDay(
      new Date("2026-09-12T01:00:00Z"),
      new Date("2026-09-12T05:00:00Z"),
      AR,
    );

    expect(partes.map((p) => p.workDate)).toEqual(["2026-09-11", "2026-09-12"]);
  });

  it("un turno de varios días se parte en todos", () => {
    const partes = splitByLocalDay(
      new Date("2026-09-12T15:00:00Z"),
      new Date("2026-09-15T15:00:00Z"),
      AR,
    );

    expect(partes.map((p) => p.workDate)).toEqual([
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
    ]);
    expect(partes.reduce((s, p) => s + p.seconds, 0)).toBe(3 * 24 * 3600);
  });

  it("un rango vacío o invertido no produce nada", () => {
    const momento = new Date("2026-09-12T15:00:00Z");
    expect(splitByLocalDay(momento, momento, AR)).toHaveLength(0);
    expect(splitByLocalDay(momento, new Date("2026-09-12T14:00:00Z"), AR)).toHaveLength(0);
  });
});

describe("cómo se muestran y se liquidan los tiempos", () => {
  it("muestra la duración como en los registros", () => {
    expect(formatDuration(6533)).toBe("1h 48m 53s");
    expect(formatDuration(1668)).toBe("27m 48s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(3600)).toBe("1h 0m 0s");
    expect(formatDuration(-10)).toBe("0s");
  });

  it("redondea a minutos al medio minuto", () => {
    expect(secondsToMinutes(0)).toBe(0);
    expect(secondsToMinutes(29)).toBe(0);
    expect(secondsToMinutes(30)).toBe(1);
    expect(secondsToMinutes(89)).toBe(1);
    expect(secondsToMinutes(90)).toBe(2);
    expect(secondsToMinutes(6533)).toBe(109);
  });

  it("acumular en segundos no pierde tiempo, acumular en minutos sí", () => {
    // Diez turnos de 29 segundos. Si cada uno se redondeara al guardarse,
    // los diez sumarían cero; acumulando segundos suman casi cinco minutos.
    const turnos = Array.from({ length: 10 }, () => 29);

    const redondeandoCadaVez = turnos.reduce((s, t) => s + secondsToMinutes(t), 0);
    const acumulandoSegundos = secondsToMinutes(turnos.reduce((s, t) => s + t, 0));

    expect(redondeandoCadaVez).toBe(0);
    expect(acumulandoSegundos).toBe(5);
  });
});
