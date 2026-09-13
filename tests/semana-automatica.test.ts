import { describe, expect, it } from "vitest";

import { weekStartFor } from "@/server/rotation";

/**
 * De qué semana es cada día.
 *
 * Imperio RP liquida de sábado a viernes, así que la semana de un día es la que
 * arranca en el sábado anterior — o en el propio día, si ese día ES sábado. El
 * borde del domingo es el que más se equivoca al escribirlo a mano: para el
 * resto del mundo el domingo abre la semana, y acá la cierra recién empezada.
 */
describe("el sábado de cada semana", () => {
  it("un sábado es su propio arranque", () => {
    // 2026-09-12 es sábado.
    expect(weekStartFor("2026-09-12")).toBe("2026-09-12");
  });

  it("el domingo pertenece al sábado anterior, no al siguiente", () => {
    expect(weekStartFor("2026-09-13")).toBe("2026-09-12");
  });

  it("el viernes cierra la semana que arrancó seis días antes", () => {
    expect(weekStartFor("2026-09-18")).toBe("2026-09-12");
  });

  it("cruza el fin de mes sin perderse", () => {
    // 2026-10-03 es sábado; el 2 de octubre todavía es de la semana anterior.
    expect(weekStartFor("2026-10-02")).toBe("2026-09-26");
    expect(weekStartFor("2026-10-03")).toBe("2026-10-03");
  });

  it("cada día de una semana devuelve el mismo sábado", () => {
    const dias = [
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ];

    expect(new Set(dias.map(weekStartFor))).toEqual(new Set(["2026-09-12"]));
  });

  it("el día siguiente al viernes ya es de la semana que viene", () => {
    expect(weekStartFor("2026-09-19")).toBe("2026-09-19");
  });
});
