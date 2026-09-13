import { describe, expect, it, vi } from "vitest";

import {
  ESTADO_VIGIA_INICIAL,
  consultarPagina,
  describirProblemas,
  evaluarChequeo,
  type Chequeo,
  type EstadoVigia,
} from "@/bot/vigia";

/**
 * La vigilancia de la página, sin Discord ni red.
 *
 * Lo que importa probar es cuándo avisa y cuándo no: una alarma que salta por
 * cualquier corte se silencia en una semana, y una que no avisa cuando vuelve
 * deja a los fundadores sin saber si ya pueden decirle al staff que entre.
 */

const MAL: Chequeo = { ok: false, motivo: "No respondió en 25 segundos." };
const BIEN: Chequeo = { ok: true };

/** Un chequeo cada cinco minutos, desde las 17:00. */
const momento = (paso: number) => new Date(Date.UTC(2026, 8, 13, 20, paso * 5));

function correr(pasos: readonly { readonly chequeo: Chequeo; readonly profundo?: boolean }[]) {
  let estado: EstadoVigia = ESTADO_VIGIA_INICIAL;

  return pasos.map((paso, indice) => {
    const resultado = evaluarChequeo(estado, paso.chequeo, {
      ahora: momento(indice),
      profundo: paso.profundo ?? true,
    });
    estado = resultado.estado;
    return resultado.decision;
  });
}

const tipos = (decisiones: readonly { readonly tipo: string }[]) => decisiones.map((d) => d.tipo);

describe("cuándo avisa la vigilancia", () => {
  it("un fallo suelto no avisa: se reintenta, y si vuelve a andar no pasó nada", () => {
    expect(tipos(correr([{ chequeo: MAL }, { chequeo: BIEN }]))).toEqual(["reintentar", "nada"]);
  });

  it("dos fallos seguidos avisan una sola vez, con la hora del primero", () => {
    const decisiones = correr([
      { chequeo: MAL },
      { chequeo: MAL },
      { chequeo: MAL },
      { chequeo: MAL },
    ]);

    expect(tipos(decisiones)).toEqual(["reintentar", "avisar-caida", "nada", "nada"]);
    expect(decisiones[1]).toEqual({ tipo: "avisar-caida", desde: momento(0), motivo: MAL.motivo });
  });

  it("cuando vuelve avisa, con cuánto duró", () => {
    const decisiones = correr([
      { chequeo: MAL },
      { chequeo: MAL },
      { chequeo: MAL },
      { chequeo: BIEN },
    ]);

    expect(decisiones[3]).toEqual({
      tipo: "avisar-vuelta",
      desde: momento(0),
      duracionMs: 15 * 60 * 1000,
    });
  });

  it("con la caída avisada, que responda la página no alcanza: tiene que responder la base", () => {
    const decisiones = correr([
      { chequeo: MAL },
      { chequeo: MAL },
      { chequeo: BIEN, profundo: false },
      { chequeo: BIEN, profundo: true },
    ]);

    expect(tipos(decisiones)).toEqual(["reintentar", "avisar-caida", "nada", "avisar-vuelta"]);
  });

  it("después de volver, una caída nueva se avisa de nuevo", () => {
    const decisiones = correr([
      { chequeo: MAL },
      { chequeo: MAL },
      { chequeo: BIEN },
      { chequeo: MAL },
      { chequeo: MAL },
    ]);

    expect(tipos(decisiones)).toEqual([
      "reintentar",
      "avisar-caida",
      "avisar-vuelta",
      "reintentar",
      "avisar-caida",
    ]);
  });
});

describe("qué dice el aviso", () => {
  it("con el detalle de /api/ready, nombra lo que falla", () => {
    expect(
      describirProblemas({
        status: "degraded",
        checks: {
          database: { ok: false },
          configuration: { ok: true, problems: [] },
          migrations: { ok: false, pending: 0 },
        },
      }),
    ).toBe("la base de datos no responde");

    expect(
      describirProblemas({
        status: "degraded",
        checks: {
          database: { ok: true },
          configuration: {
            ok: false,
            problems: ["SESSION_SECRET sigue siendo **de desarrollo**."],
          },
          migrations: { pending: 2 },
        },
      }),
    ).toBe(
      "la configuración tiene problemas (SESSION_SECRET sigue siendo de desarrollo.), " +
        "2 migraciones pendientes",
    );
  });

  it("sin el detalle igual distingue una página degradada, y lo que no entiende no lo inventa", () => {
    expect(describirProblemas({ status: "degraded" })).toContain("base");
    expect(describirProblemas({ status: "ready", checks: { database: { ok: true } } })).toBeNull();
    expect(describirProblemas(null)).toBeNull();
  });
});

describe("consultar la página", () => {
  const responder = (status: number, cuerpo?: unknown) =>
    new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), { status });

  const falsoFetch = (implementacion: () => Promise<Response>) =>
    vi.fn(async (_url: string, _init?: RequestInit) => implementacion());

  it("el chequeo liviano mira /api/health; el completo, /api/ready con el secreto", async () => {
    const pedir = falsoFetch(async () => responder(200, { status: "ok" }));
    const comoFetch = pedir as unknown as typeof fetch;

    expect(
      await consultarPagina("https://x.example", { profundo: false, fetch: comoFetch }),
    ).toEqual(BIEN);
    await consultarPagina("https://x.example", { profundo: true, secreto: "s3", fetch: comoFetch });

    expect(pedir.mock.calls[0]?.[0]).toBe("https://x.example/api/health");
    expect(pedir.mock.calls[1]?.[0]).toBe("https://x.example/api/ready");
    expect(pedir.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: "Bearer s3" } });
  });

  it("un error de la página vuelve con el código y lo que falla", async () => {
    const pedir = falsoFetch(async () =>
      responder(503, { status: "degraded", checks: { database: { ok: false } } }),
    );

    expect(
      await consultarPagina("https://x.example", {
        profundo: true,
        fetch: pedir as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, motivo: "Respondió con error 503: la base de datos no responde." });
  });

  it("si no contesta a tiempo, lo dice", async () => {
    const pedir = falsoFetch(async () => {
      throw new DOMException("tardó", "TimeoutError");
    });

    expect(
      await consultarPagina("https://x.example", {
        profundo: false,
        fetch: pedir as unknown as typeof fetch,
        timeoutMs: 25_000,
      }),
    ).toEqual({ ok: false, motivo: "No respondió en 25 segundos." });
  });

  it("si no puede conectar, dice el código y nada del texto crudo del error", async () => {
    const pedir = falsoFetch(async () => {
      throw Object.assign(new TypeError("fetch failed `raro`"), { cause: { code: "ENOTFOUND" } });
    });

    expect(
      await consultarPagina("https://x.example", {
        profundo: false,
        fetch: pedir as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, motivo: "No se pudo conectar (ENOTFOUND)." });
  });
});
