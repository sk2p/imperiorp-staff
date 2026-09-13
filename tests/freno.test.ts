import { beforeEach, describe, expect, it, vi } from "vitest";

import { consumir, origenDe, reiniciarFreno } from "@/lib/core/throttle";

/**
 * El freno de pedidos por origen.
 *
 * Lo que se prueba acá es lo que hay que poder afirmar sin dudar: que corta
 * cuando corresponde, que se suelta solo cuando pasa la ventana, y que una
 * dirección no arrastra a las demás. Un freno que corta de más deja a cuarenta
 * personas afuera; uno que corta de menos no sirve para nada.
 */
describe("freno de pedidos", () => {
  beforeEach(() => {
    reiniciarFreno();
    vi.useRealTimers();
  });

  const presupuesto = { maximo: 3, ventanaMs: 1000 } as const;

  it("deja pasar hasta el tope y corta el siguiente", () => {
    expect(consumir("a", presupuesto).permitido).toBe(true);
    expect(consumir("a", presupuesto).permitido).toBe(true);
    expect(consumir("a", presupuesto).permitido).toBe(true);

    const cuarto = consumir("a", presupuesto);
    expect(cuarto.permitido).toBe(false);
    expect(cuarto.esperaSegundos).toBeGreaterThan(0);
  });

  it("cuenta cuántos quedan", () => {
    expect(consumir("b", presupuesto).restantes).toBe(2);
    expect(consumir("b", presupuesto).restantes).toBe(1);
    expect(consumir("b", presupuesto).restantes).toBe(0);
  });

  it("cada origen tiene su propio presupuesto", () => {
    for (let i = 0; i < 5; i += 1) consumir("uno", presupuesto);

    // El primero ya está cortado; el segundo ni se enteró.
    expect(consumir("uno", presupuesto).permitido).toBe(false);
    expect(consumir("dos", presupuesto).permitido).toBe(true);
  });

  it("se suelta solo cuando pasa la ventana", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));

    for (let i = 0; i < 4; i += 1) consumir("c", presupuesto);
    expect(consumir("c", presupuesto).permitido).toBe(false);

    vi.setSystemTime(new Date("2026-09-12T12:00:02Z"));
    expect(consumir("c", presupuesto).permitido).toBe(true);
  });

  it("lee la primera dirección de la cadena de proxies, que es la del cliente", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" });
    expect(origenDe(headers)).toBe("203.0.113.7");
  });

  it("sin cabecera de proxy no inventa direcciones", () => {
    expect(origenDe(new Headers())).toBe("desconocido");
  });
});
