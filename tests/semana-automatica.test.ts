import { describe, expect, it } from "vitest";

import { weekStartFor } from "@/server/rotation";

/**
 * De qué semana es cada día.
 *
 * Imperio RP liquida de viernes a viernes (semana de viernes a jueves),
 * así que la semana de un día es la que arranca en el viernes anterior —
 * o en el propio día, si ese día ES viernes.
 */
describe("el viernes de cada semana", () => {
  it("un viernes es su propio arranque", () => {
    // 2026-09-11 es viernes.
    expect(weekStartFor("2026-09-11")).toBe("2026-09-11");
  });

  it("el sábado pertenece al viernes anterior", () => {
    // 2026-09-12 es sábado.
    expect(weekStartFor("2026-09-12")).toBe("2026-09-11");
  });

  it("el domingo pertenece al viernes anterior", () => {
    // 2026-09-13 es domingo.
    expect(weekStartFor("2026-09-13")).toBe("2026-09-11");
  });

  it("el jueves cierra la semana que arrancó seis días antes", () => {
    // 2026-09-17 es jueves.
    expect(weekStartFor("2026-09-17")).toBe("2026-09-11");
  });

  it("cruza el fin de mes sin perderse", () => {
    // 2026-10-02 es viernes; el 1 de octubre (jueves) todavía es de la semana que arrancó el 25 de septiembre.
    expect(weekStartFor("2026-10-01")).toBe("2026-09-25");
    expect(weekStartFor("2026-10-02")).toBe("2026-10-02");
  });

  it("cada día de una semana devuelve el mismo viernes", () => {
    const dias = [
      "2026-09-11", // viernes
      "2026-09-12", // sábado
      "2026-09-13", // domingo
      "2026-09-14", // lunes
      "2026-09-15", // martes
      "2026-09-16", // miércoles
      "2026-09-17", // jueves
    ];

    expect(new Set(dias.map(weekStartFor))).toEqual(new Set(["2026-09-11"]));
  });

  it("el día siguiente al jueves ya es de la semana que viene", () => {
    expect(weekStartFor("2026-09-18")).toBe("2026-09-18");
  });
});
