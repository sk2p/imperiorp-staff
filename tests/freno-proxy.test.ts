import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { reiniciarFreno } from "@/lib/core/throttle";
import { proxy } from "@/proxy";

/**
 * El freno, probado donde de verdad se arma la clave: en el proxy.
 *
 * Los tres presupuestos —lectura, escritura, acceso— compartían contador. Leer
 * páginas y abrir la pantalla de ingreso sumaban en la misma cuenta, pero cada
 * una se comparaba contra su propio tope, y el de ingreso es el más bajo. El
 * resultado: alguien que venía trabajando, con la sesión vencida, caía en
 * `/ingresar` después de haber gastado ese cupo en imágenes y refrescos, y lo
 * recibía "Frená un toque". Justo en la pantalla que tiene que funcionar.
 */
describe("el freno en el proxy", () => {
  beforeEach(() => {
    reiniciarFreno();
  });

  it("navegar no gasta el cupo de la pantalla de ingreso", () => {
    for (let i = 0; i < 200; i += 1) {
      proxy(new NextRequest("http://localhost/pagos"));
    }

    const ingreso = proxy(new NextRequest("http://localhost/ingresar"));

    expect(ingreso.status).not.toBe(429);
  });

  it("la pantalla de ingreso sigue teniendo su propio tope", () => {
    const respuestas = Array.from({ length: 400 }, () =>
      proxy(new NextRequest("http://localhost/ingresar")),
    );

    expect(respuestas.some((respuesta) => respuesta.status === 429)).toBe(true);
  });
});
