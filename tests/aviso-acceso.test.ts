import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Cookies de mentira: `performLogin` las usa y fuera de un pedido no existen. */
const tarro = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nombre: string) => {
      const value = tarro.get(nombre);
      return value === undefined ? undefined : { name: nombre, value };
    },
    set: (nombre: string, valor: string) => {
      if (valor === "") tarro.delete(nombre);
      else tarro.set(nombre, valor);
    },
  }),
  headers: async () => new Headers(),
}));

import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { staffMembers, users } from "@/db/schema";
import { RANK_DEFINITIONS } from "@/domain/ranks";
import { hashPassword } from "@/lib/auth/password";
import { lugarDeVercel } from "@/lib/core/lugar";
import { performLogin } from "@/server/auth-flow";
import { describirNavegador, notifyNewBrowserLogin } from "@/server/discord-notify";

/**
 * El aviso por privado cuando alguien entra desde un navegador nuevo.
 *
 * Lo que tiene que cumplir: llegarle al dueño de la cuenta, decir lo justo para
 * reconocer —o no— el acceso, no repetirse desde el navegador de siempre, y no
 * dejar que nada de lo que viene en el pedido arme formato o menciones en
 * Discord.
 */

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Reemplaza a Discord: anota cada pedido y contesta como si todo anduviera. */
function espiarDiscord() {
  vi.stubEnv("DISCORD_TOKEN", "token-de-prueba");
  const pedidos: { url: string; cuerpo: Record<string, unknown> }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      pedidos.push({
        url: String(url),
        cuerpo: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ id: "999999999999999999" }), { status: 200 });
    }),
  );

  return pedidos;
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cómo se describe el acceso", () => {
  it("el navegador y el sistema, en palabras", () => {
    const casos: [string | null, string][] = [
      [CHROME_WINDOWS, "Chrome en Windows"],
      [CHROME_WINDOWS + " Edg/140.0.0.0", "Edge en Windows"],
      [CHROME_WINDOWS + " OPR/115.0.0.0", "Opera en Windows"],
      [
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
        "Firefox en Linux",
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        "Safari en iPhone",
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
        "Chrome en Android",
      ],
      [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
        "Safari en Mac",
      ],
      ["curl/8.5.0", "Otro navegador en otro sistema"],
      [null, "Navegador desconocido"],
    ];

    for (const [agente, esperado] of casos) {
      expect(describirNavegador(agente), String(agente)).toBe(esperado);
    }
  });

  it("el lugar sale de las cabeceras de Vercel, decodificado y sin formato", () => {
    const cabeceras = (valores: Record<string, string>) => (nombre: string) =>
      valores[nombre] ?? null;

    expect(
      lugarDeVercel(
        cabeceras({ "x-vercel-ip-city": "S%C3%A3o%20Paulo", "x-vercel-ip-country": "BR" }),
      ),
    ).toBe("São Paulo, BR");
    expect(lugarDeVercel(cabeceras({}))).toBeUndefined();

    const trucho = lugarDeVercel(
      cabeceras({
        "x-vercel-ip-city": "%5Bclick%5D(https%3A%2F%2Fevil.example)**%40everyone**",
        "x-vercel-ip-country": "AR<>",
      }),
    );
    expect(trucho).not.toMatch(/[[\]()*@<>:/]/);

    // Mal codificada: no revienta.
    expect(lugarDeVercel(cabeceras({ "x-vercel-ip-city": "%E0%A4%A" }))).toBeDefined();
  });

  it("el privado lleva cuenta, navegador, lugar e IP, y no menciona a nadie", async () => {
    const pedidos = espiarDiscord();

    await notifyNewBrowserLogin({
      discordUserId: "123456789012345678",
      username: "pit",
      navegador: "Chrome en Windows",
      ip: "200.1.2.3",
      lugar: "Rosario, AR",
      cuando: new Date("2026-09-13T21:00:00Z"),
      urlCuenta: "https://imperiorp-staff.vercel.app/perfil",
    });

    expect(pedidos.map((pedido) => pedido.url)).toEqual([
      "https://discord.com/api/v10/users/@me/channels",
      "https://discord.com/api/v10/channels/999999999999999999/messages",
    ]);
    expect(pedidos[0]?.cuerpo).toEqual({ recipient_id: "123456789012345678" });
    expect(pedidos[1]?.cuerpo.allowed_mentions).toEqual({ parse: [] });

    const texto = JSON.stringify(pedidos[1]?.cuerpo);
    for (const dato of [
      "pit",
      "Chrome en Windows",
      "Rosario, AR",
      "200.1.2.3",
      "[Mi cuenta](https://imperiorp-staff.vercel.app/perfil)",
    ]) {
      expect(texto).toContain(dato);
    }
  });

  it("una IP que no es una IP no entra al mensaje", async () => {
    const pedidos = espiarDiscord();

    await notifyNewBrowserLogin({
      discordUserId: "123456789012345678",
      username: "pit",
      navegador: "Chrome en Windows",
      ip: "<@&1> [x](https://evil.example)",
      lugar: null,
      cuando: new Date(),
      urlCuenta: null,
    });

    const texto = JSON.stringify(pedidos[1]?.cuerpo);
    expect(texto).not.toContain("evil.example");
    expect(texto).toContain("Ubicación desconocida");
    expect(texto).toContain("**Mi cuenta**");
  });
});

describe("al entrar desde un navegador nuevo", () => {
  const CLAVE = "Avisada-Imperio-2026!";

  beforeAll(async () => {
    await runMigrations();

    const [avisada] = await db
      .insert(users)
      .values({ username: "avisada", passwordHash: await hashPassword(CLAVE), role: "FOUNDER" })
      .returning();
    await db.insert(staffMembers).values({
      name: "Avisada",
      rank: "ADM",
      category: RANK_DEFINITIONS.ADM.category,
      joinedAt: "2026-06-01",
      userId: avisada!.id,
      discordUserId: "123456789012345678",
    });

    await db
      .insert(users)
      .values({ username: "suelta", passwordHash: await hashPassword(CLAVE), role: "AUDITOR" });
  }, 60_000);

  beforeEach(() => {
    tarro.clear();
  });

  const entrar = (usuario: string) =>
    performLogin(
      { username: usuario, password: CLAVE },
      { ip: "200.1.2.3", userAgent: CHROME_WINDOWS, lugar: "Rosario, AR" },
    );

  it("le escribe al dueño, y desde el mismo navegador no vuelve a escribir", async () => {
    const pedidos = espiarDiscord();

    await entrar("avisada");
    await vi.waitFor(() => expect(pedidos).toHaveLength(2), { timeout: 5000 });
    expect(pedidos[0]?.cuerpo).toEqual({ recipient_id: "123456789012345678" });
    expect(JSON.stringify(pedidos[1]?.cuerpo)).toContain("Rosario, AR");

    // El tarro ya tiene la marca del acceso anterior: es el navegador de siempre.
    await entrar("avisada");
    await esperar(500);
    expect(pedidos).toHaveLength(2);
  });

  it("sin Discord vinculado no manda nada, y el acceso anda igual", async () => {
    const pedidos = espiarDiscord();

    await expect(entrar("suelta")).resolves.toMatchObject({ username: "suelta" });
    await esperar(500);
    expect(pedidos).toHaveLength(0);
  });
});
