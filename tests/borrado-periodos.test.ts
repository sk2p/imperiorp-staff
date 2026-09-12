import { describe, expect, it } from "vitest";

import { resolverPreflight } from "@/server/weeks";

/**
 * La regla de borrado de períodos.
 *
 * Borrar no se deshace, así que lo único que se borra es lo que no contiene
 * nada. Estos casos existen para que el día que alguien quiera "flexibilizar
 * un poquito" la regla, el test se lo diga en la cara antes de que se pierdan
 * las horas de cuarenta personas.
 */

const vacio = {
  conTiempo: 0,
  marcadas: 0,
  minutos: 0,
  personas: 0,
  paymentCount: 0,
  paymentsVoided: 0,
  emptyRecords: 0,
};

describe("qué período se puede borrar", () => {
  it("un período sin nada adentro se borra", () => {
    const veredicto = resolverPreflight({ ...vacio, emptyRecords: 43 });

    expect(veredicto.canDelete).toBe(true);
    expect(veredicto.blocker).toBeNull();
  });

  it("con horas cargadas no se borra, y dice cuántas y de cuántos", () => {
    const veredicto = resolverPreflight({
      ...vacio,
      conTiempo: 120,
      minutos: 30_782,
      personas: 37,
    });

    expect(veredicto.canDelete).toBe(false);
    expect(veredicto.blocker).toContain("513h 2m");
    expect(veredicto.blocker).toContain("37 personas");
  });

  it("un pago anulado sigue frenando el borrado, y se aclara que lo está", () => {
    const veredicto = resolverPreflight({ ...vacio, paymentCount: 6, paymentsVoided: 6 });

    expect(veredicto.canDelete).toBe(false);
    expect(veredicto.blocker).toContain("todos anulados");
  });

  it("un solo pago anulado se nombra en singular", () => {
    const veredicto = resolverPreflight({ ...vacio, paymentCount: 1, paymentsVoided: 1 });

    expect(veredicto.blocker).toContain("1 pago registrado, anulado");
  });

  it("los pagos mandan por encima de las horas: es el motivo más terminante", () => {
    const veredicto = resolverPreflight({
      ...vacio,
      conTiempo: 10,
      minutos: 600,
      personas: 3,
      paymentCount: 2,
      paymentsVoided: 0,
    });

    expect(veredicto.blocker).toContain("pagos registrados");
    expect(veredicto.blocker).not.toContain("10h");
  });

  /**
   * Poner una casilla en cero desde la planilla no borra la entrada: la anula.
   * La entrada se queda con sus minutos y una marca de anulación, y los totales
   * la ignoran. Contarla como horas hacía que el sistema dijera "tiene horas
   * cargadas" sobre un período que en pantalla estaba vacío.
   */
  it("un día anulado no frena: no tiene horas vigentes", () => {
    const veredicto = resolverPreflight({ ...vacio, marcadas: 1 });

    expect(veredicto.canDelete).toBe(true);
    expect(veredicto.blocker).toBeNull();
    // Pero se informa, porque se va con el período.
    expect(veredicto.markedEntries).toBe(1);
  });
});
