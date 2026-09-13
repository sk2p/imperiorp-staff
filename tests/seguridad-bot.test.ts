import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MENCIONES_PERMITIDAS,
  decidirAdministracion,
  esAdministracion,
  esDeOtroServidor,
  esIdDeDiscord,
  esIdDeFicha,
} from "@/bot/guardia";
import { RANK_DEFINITIONS, STAFF_RANKS } from "@/domain/ranks";

/**
 * Seguridad del bot de fichajes.
 *
 * El bot atiende a cualquiera que esté en el servidor de Discord, y lo que
 * decide —de quién son las horas, quién ve lo que cobra otro— es plata. Las
 * reglas viven en `src/bot/guardia.ts` para poder probarlas; lo último de este
 * archivo verifica que `index.ts` las use donde tiene que usarlas.
 */

describe("quién administra el fichaje", () => {
  it("decide el rango: de ADM para arriba", () => {
    for (const rank of STAFF_RANKS) {
      expect(esAdministracion({ rank }), rank).toBe(
        RANK_DEFINITIONS[rank].tier >= RANK_DEFINITIONS.ADM.tier,
      );
    }
    expect(esAdministracion({ rank: "ADM" })).toBe(true);
    expect(esAdministracion({ rank: "MOD" })).toBe(false);
    expect(esAdministracion({ rank: "inventado" })).toBe(false);
    expect(esAdministracion(null)).toBe(false);
  });

  it("a un ADM se lo reconoce sin consultar nada más", async () => {
    const consulta = vi.fn(async () => true);

    const ok = await decidirAdministracion({
      member: { rank: "ADM" },
      hayAdministracionVinculada: consulta,
      gestionaServidor: false,
    });

    expect(ok).toBe(true);
    expect(consulta).not.toHaveBeenCalled();
  });

  it("administrar Discord alcanza sólo mientras no haya ningún ADM vinculado", async () => {
    const moderador = { member: { rank: "MOD" }, gestionaServidor: true };

    expect(
      await decidirAdministracion({ ...moderador, hayAdministracionVinculada: async () => false }),
    ).toBe(true);
    expect(
      await decidirAdministracion({ ...moderador, hayAdministracionVinculada: async () => true }),
    ).toBe(false);
    expect(
      await decidirAdministracion({
        member: null,
        gestionaServidor: false,
        hayAdministracionVinculada: async () => false,
      }),
    ).toBe(false);
  });
});

describe("de dónde vienen las interacciones", () => {
  it("sólo del servidor configurado, o por privado", () => {
    expect(esDeOtroServidor("100", "100")).toBe(false);
    expect(esDeOtroServidor("200", "100")).toBe(true);
    expect(esDeOtroServidor(null, "100")).toBe(false);
    expect(esDeOtroServidor("200", null)).toBe(false);
  });
});

describe("lo que se escribe en Discord", () => {
  it("una ficha es un identificador, no un texto cualquiera", () => {
    expect(esIdDeFicha("3f2b8c1e-9a4d-4e21-b7c3-5d6e7f8a9b0c")).toBe(true);

    for (const valor of [
      "Martin",
      "' or 1=1 --",
      "",
      "3f2b8c1e-9a4d-4e21-b7c3-5d6e7f8a9b0c; drop table staff_members",
      null,
      undefined,
    ]) {
      expect(esIdDeFicha(valor), String(valor)).toBe(false);
    }
  });

  it("una cuenta de Discord son sólo dígitos", () => {
    expect(esIdDeDiscord("123456789012345678")).toBe(true);

    for (const valor of ["abc", "12345", "1".repeat(25), "<@123456789012345678>", null]) {
      expect(esIdDeDiscord(valor), String(valor)).toBe(false);
    }
  });

  it("sólo suenan menciones a personas: nunca @everyone ni roles", () => {
    expect(MENCIONES_PERMITIDAS.parse).toEqual(["users"]);
    expect(MENCIONES_PERMITIDAS.repliedUser).toBe(false);
  });
});

describe("el bot usa las reglas donde corresponde", () => {
  const fuente = readFileSync(path.resolve(import.meta.dirname, "../src/bot/index.ts"), "utf8");

  it("el cliente sale con las menciones restringidas", () => {
    expect(fuente).toMatch(
      /new Client\(\{[\s\S]*?allowedMentions: MENCIONES_PERMITIDAS[\s\S]*?\}\);/,
    );
  });

  it("el autocompletado pide permiso y pasa por el freno antes de listar fichas", () => {
    /**
     * Discord dispara el autocompletado a CUALQUIERA que escriba el comando,
     * tenga o no permiso para ejecutarlo, y con cada tecla. Sin esto, cualquier
     * miembro del servidor recorría la lista del staff y ponía a la base a
     * consultar sin freno.
     */
    const bloque = fuente.slice(fuente.indexOf("interaction.isAutocomplete()"));
    const listar = bloque.indexOf("listUnlinkedMembers(");

    expect(listar).toBeGreaterThan(0);
    for (const control of ["FRENO_AUTOCOMPLETADO", "puedeAdministrar("]) {
      expect(bloque.indexOf(control), control).toBeGreaterThan(-1);
      expect(bloque.indexOf(control), control).toBeLessThan(listar);
    }
  });

  it("descarta lo que llega de otro servidor antes de tocar nada", () => {
    const manejador = fuente.slice(fuente.indexOf("Events.InteractionCreate"));
    const filtro = manejador.indexOf("esDeOtroServidor(");

    expect(filtro).toBeGreaterThan(-1);
    expect(filtro).toBeLessThan(manejador.indexOf("deferReply("));
  });

  it("/vincular valida la ficha antes de ir a la base", () => {
    const vincular = fuente.slice(fuente.indexOf('commandName === "vincular"'));
    const control = vincular.indexOf("esIdDeFicha(");

    expect(control).toBeGreaterThan(-1);
    expect(control).toBeLessThan(vincular.indexOf("linkDiscordAccount("));
  });
});
