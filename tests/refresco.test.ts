import { describe, expect, it } from "vitest";

import {
  INTERVALO_MS,
  INTERVALO_QUIETO_MS,
  QUIETO_TRAS_MS,
  REFRESCO_COMPLETO_MS,
  hayQueRedibujar,
  tocaMirar,
} from "@/lib/core/refresco";

/**
 * El refresco en vivo.
 *
 * Antes redibujaba la pantalla entera cada doce segundos, cambiara algo o no.
 * Ahora pregunta primero. Lo que hay que poder afirmar: que no se pierde un
 * cambio, que no redibuja de gusto, y que una pantalla olvidada en una pestaña
 * deja de molestar a la base.
 */
describe("cuándo mirar", () => {
  const T = 1_000_000;

  it("con alguien usando la pantalla, mira cada doce segundos", () => {
    expect(tocaMirar({ ahora: T + 5_000, ultimaMirada: T, ultimaActividad: T })).toBe(false);
    expect(tocaMirar({ ahora: T + INTERVALO_MS, ultimaMirada: T, ultimaActividad: T })).toBe(true);
  });

  it("tolera que el temporizador llegue apenas antes", () => {
    expect(tocaMirar({ ahora: T + INTERVALO_MS - 100, ultimaMirada: T, ultimaActividad: T })).toBe(
      true,
    );
  });

  it("una pantalla que quedó sola mira mucho menos", () => {
    const quieta = T - QUIETO_TRAS_MS;

    expect(tocaMirar({ ahora: T + INTERVALO_MS, ultimaMirada: T, ultimaActividad: quieta })).toBe(
      false,
    );
    expect(
      tocaMirar({ ahora: T + INTERVALO_QUIETO_MS, ultimaMirada: T, ultimaActividad: quieta }),
    ).toBe(true);
  });
});

describe("cuándo redibujar", () => {
  const T = 5_000_000;
  const hace = (ms: number) => T - ms;

  it("redibuja cuando cambió la firma", () => {
    expect(
      hayQueRedibujar({
        firmaPantalla: "10:4.3:2",
        firmaServidor: "11:4.3:2",
        ahora: T,
        ultimoRedibujo: hace(30_000),
      }),
    ).toBe(true);
  });

  it("con la misma firma no redibuja de gusto", () => {
    expect(
      hayQueRedibujar({
        firmaPantalla: "10:4.3:2",
        firmaServidor: "10:4.3:2",
        ahora: T,
        ultimoRedibujo: hace(30_000),
      }),
    ).toBe(false);
  });

  it("pero cada tanto redibuja igual, por lo que la firma no ve", () => {
    expect(
      hayQueRedibujar({
        firmaPantalla: "10:4.3:2",
        firmaServidor: "10:4.3:2",
        ahora: T,
        ultimoRedibujo: hace(REFRESCO_COMPLETO_MS),
      }),
    ).toBe(true);
  });

  it("recién redibujado no vuelve a hacerlo aunque la firma difiera", () => {
    // La pantalla nueva, con su firma nueva, todavía no llegó.
    expect(
      hayQueRedibujar({
        firmaPantalla: "10:4.3:2",
        firmaServidor: "11:4.3:2",
        ahora: T,
        ultimoRedibujo: hace(2_000),
      }),
    ).toBe(false);
  });

  it("sin firma del servidor no insiste contra lo que está fallando", () => {
    expect(
      hayQueRedibujar({
        firmaPantalla: "10:4.3:2",
        firmaServidor: null,
        ahora: T,
        ultimoRedibujo: hace(30_000),
      }),
    ).toBe(false);
  });

  it("si la pantalla no pudo calcular su firma, la primera que llegue manda", () => {
    expect(
      hayQueRedibujar({
        firmaPantalla: null,
        firmaServidor: "10:4.3:2",
        ahora: T,
        ultimoRedibujo: hace(30_000),
      }),
    ).toBe(true);
  });
});
