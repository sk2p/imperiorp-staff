import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las cookies del pedido, de mentira. `performLogin` escribe la sesión y la
 * marca de navegador con `cookies()` de Next, que fuera de un pedido real no
 * existe. Esto la reemplaza por un frasco que el test puede mirar y llenar.
 */
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
import { sessions, users } from "@/db/schema";
import { PERMISSIONS } from "@/domain/permissions";
import { requireAuth, requirePermission } from "@/lib/auth/context";
import { DEVICE_COOKIE } from "@/lib/auth/dispositivo";
import { hashPassword } from "@/lib/auth/password";
import { createSession, revokeOwnSession, SESSION_COOKIE } from "@/lib/auth/session";
import { isAppError } from "@/lib/core/errors";
import { performLogin } from "@/server/auth-flow";

/**
 * El acceso, contra una base de verdad —PGlite en memoria, con migraciones—.
 *
 * Lo que se prueba acá son ataques concretos, escritos como los haría alguien
 * que quiere entrar o dejar afuera a otro:
 *
 *   · Dejar al Fundador afuera para siempre con saber su nombre de usuario.
 *   · Usar la marca de navegador de una cuenta para saltear el bloqueo de otra.
 *   · Operar con la contraseña temporal sin cambiarla nunca.
 *   · Cerrarle la sesión a un compañero mandando el id de su sesión.
 */

const CLAVE = "Victima-Imperio-2026!";
const CLAVE_OTRA = "Otra-Cuenta-Imperio-2026!";

let victimaId = "";

beforeAll(async () => {
  await runMigrations();

  const [victima] = await db
    .insert(users)
    .values({
      username: "victima",
      displayName: "Víctima",
      passwordHash: await hashPassword(CLAVE),
      role: "FOUNDER",
    })
    .returning();
  victimaId = victima!.id;
  // Las migraciones sobre una base nueva tardan; con la máquina ocupada pasan
  // los diez segundos que vitest le da a un gancho.
}, 60_000);

beforeEach(() => {
  tarro.clear();
});

/** Un intento de acceso. Devuelve "entró" o el código del error. */
async function intentar(usuario: string, clave: string, ip: string): Promise<string> {
  try {
    await performLogin({ username: usuario, password: clave }, { ip, userAgent: "test" });
    return "entró";
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
}

async function cuenta(id: string) {
  const [fila] = await db.select().from(users).where(eq(users.id, id));
  return fila!;
}

/**
 * Cinco contraseñas mal desde cinco IP distintas: así se esquiva el límite por
 * IP, y así se ataca de verdad una cuenta concreta.
 */
async function bloquearDesdeAfuera(usuario: string, prefijoIp: string): Promise<void> {
  for (let i = 1; i <= 5; i += 1) {
    expect(await intentar(usuario, "mal-" + i, prefijoIp + i)).toBe("UNAUTHENTICATED");
  }
}

describe("bloqueo de cuentas", () => {
  it("cinco contraseñas mal bloquean la cuenta aunque vengan de IP distintas", async () => {
    await bloquearDesdeAfuera("victima", "10.0.0.");

    expect((await cuenta(victimaId)).lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Con la cuenta bloqueada, la contraseña correcta desde un navegador
    // desconocido tampoco entra: si no, el bloqueo no frenaría nada.
    expect(await intentar("victima", CLAVE, "10.0.1.1")).toBe("UNAUTHENTICATED");
    expect(tarro.has(SESSION_COOKIE)).toBe(false);
  });

  it("un bloqueo vencido no queda cargado: un solo error no vuelve a bloquear", async () => {
    // Pasaron los quince minutos.
    await db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, victimaId));

    // Antes, este único intento —el sexto fallo anotado— volvía a bloquear.
    expect(await intentar("victima", "otra-mal", "10.0.2.1")).toBe("UNAUTHENTICATED");

    const despues = await cuenta(victimaId);
    expect(despues.failedLoginCount).toBe(1);
    expect(despues.lockedUntil).toBeNull();

    expect(await intentar("victima", CLAVE, "10.0.2.2")).toBe("entró");
    expect(tarro.get(SESSION_COOKIE)).toBeTruthy();
    expect(tarro.get(DEVICE_COOKIE)).toBeTruthy();
  });

  it("con la cuenta bloqueada por otro, su dueño entra desde su navegador", async () => {
    expect(await intentar("victima", CLAVE, "192.168.1.10")).toBe("entró");
    const marca = tarro.get(DEVICE_COOKIE)!;
    tarro.clear();

    await bloquearDesdeAfuera("victima", "10.0.3.");

    // El atacante, aun sabiendo la contraseña, no tiene la marca.
    expect(await intentar("victima", CLAVE, "10.0.3.99")).toBe("UNAUTHENTICATED");

    tarro.set(DEVICE_COOKIE, marca);
    expect(await intentar("victima", CLAVE, "192.168.1.10")).toBe("entró");
    expect((await cuenta(victimaId)).lockedUntil).toBeNull();
  });

  it("la marca de navegador de otra cuenta no abre ésta", async () => {
    await db.insert(users).values({
      username: "otra",
      passwordHash: await hashPassword(CLAVE_OTRA),
      role: "AUDITOR",
    });
    expect(await intentar("otra", CLAVE_OTRA, "192.168.1.20")).toBe("entró");
    const marcaAjena = tarro.get(DEVICE_COOKIE)!;
    tarro.clear();

    await bloquearDesdeAfuera("victima", "10.0.4.");

    tarro.set(DEVICE_COOKIE, marcaAjena);
    expect(await intentar("victima", CLAVE, "192.168.1.21")).toBe("UNAUTHENTICATED");
  });
});

describe("sesiones", () => {
  it("con la contraseña temporal pendiente, se puede cambiarla y nada más", async () => {
    const [temporal] = await db
      .insert(users)
      .values({
        username: "temporal",
        passwordHash: await hashPassword("Temporal-Imperio-2026!"),
        role: "OWNER",
        mustChangePassword: true,
      })
      .returning();

    const { rawToken } = await createSession(temporal!.id);
    tarro.set(SESSION_COOKIE, rawToken);

    // Sesión válida: puede llegar a la pantalla de cambio de contraseña.
    await expect(requireAuth()).resolves.toBeTruthy();
    // Pero cualquier cosa que pida un permiso se rechaza, aunque sea Owner.
    await expect(requirePermission(PERMISSIONS.STAFF_VIEW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("nadie cierra la sesión de otro mandando su identificador", async () => {
    const [intruso] = await db
      .insert(users)
      .values({ username: "intruso", passwordHash: await hashPassword(CLAVE), role: "AUDITOR" })
      .returning();
    const { session: ajena } = await createSession(victimaId);

    expect(await revokeOwnSession(ajena.id, intruso!.id)).toBe(false);

    const [fila] = await db.select().from(sessions).where(eq(sessions.id, ajena.id));
    expect(fila!.revokedAt).toBeNull();
  });
});
