import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PERMISSIONS,
  ROLE_DEFINITIONS,
  canManageRole,
  effectivePermissions,
  hasPermission,
} from "@/domain/permissions";
import { csrfTokenFor, isSameOrigin, verifyCsrfToken } from "@/lib/auth/csrf";
import { esMarcaValida, marcaDeDispositivo } from "@/lib/auth/dispositivo";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { coincideSecreto, portadorValido } from "@/lib/auth/secreto-compartido";
import { logger } from "@/lib/core/logger";
import { reiniciarFreno } from "@/lib/core/throttle";
import { config as configuracionProxy, proxy } from "@/proxy";
import { notifyPayment, notifyPaymentsPrivately } from "@/server/discord-notify";
import { loginSchema } from "@/validation/users";

/**
 * Pruebas de seguridad de la página que no necesitan base de datos.
 *
 * Cada bloque fija una barrera concreta: quién pasa el proxy sin sesión, qué
 * cabeceras salen, qué rechaza el anti-CSRF, a dónde puede mandar el login
 * después de entrar, qué puede cada rol. Si alguna falla no es un detalle de
 * estilo: es una puerta que quedó abierta.
 *
 * Las que necesitan base —bloqueo de cuentas, sesiones— están en
 * `seguridad-acceso.test.ts`; las guardias sobre el código fuente, en
 * `seguridad-estatica.test.ts`.
 */

const P = PERMISSIONS;

beforeEach(() => {
  reiniciarFreno();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("el proxy, sin sesión", () => {
  it.each([
    "/",
    "/horas",
    "/pagos",
    "/staff/123",
    "/configuracion",
    "/auditoria",
    "/api/firma",
    "/api/paleta",
    "/api/exportar/liquidacion?periodo=x",
  ])("%s manda a /ingresar, dentro del propio sitio", (ruta) => {
    const respuesta = proxy(new NextRequest("http://localhost" + ruta));

    expect(respuesta.status).toBe(307);
    const destino = new URL(respuesta.headers.get("location") ?? "");
    expect(destino.origin).toBe("http://localhost");
    expect(destino.pathname).toBe("/ingresar");
  });

  it.each(["/ingresar", "/api/health", "/api/ready", "/api/cron/rotar-periodo"])(
    "%s es público",
    (ruta) => {
      expect(proxy(new NextRequest("http://localhost" + ruta)).status).toBe(200);
    },
  );
});

describe("el matcher del proxy", () => {
  const patron = new RegExp("^" + configuracionProxy.matcher[0] + "$");

  it("las pantallas pasan por el proxy aunque la ruta termine en .png", () => {
    // `/staff/[id]` acepta cualquier id: `/staff/algo.png` es una pantalla.
    for (const ruta of ["/", "/horas", "/staff/algo.png", "/api/exportar/x.webp", "/a/b.svg"]) {
      expect(patron.test(ruta), ruta).toBe(true);
    }
  });

  it("los archivos públicos de la raíz y los de Next quedan afuera", () => {
    for (const ruta of ["/imperiorplogo.webp", "/favicon.ico", "/_next/static/chunks/a.js"]) {
      expect(patron.test(ruta), ruta).toBe(false);
    }
  });
});

describe("cabeceras en producción", () => {
  it("la CSP no deja evaluar texto, ni meter la página en un marco, ni cargar plugins", () => {
    vi.stubEnv("NODE_ENV", "production");
    const respuesta = proxy(new NextRequest("http://localhost/ingresar"));
    const csp = respuesta.headers.get("Content-Security-Policy") ?? "";

    expect(csp).not.toContain("unsafe-eval");
    for (const directiva of [
      "default-src 'self'",
      "'strict-dynamic'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directiva);
    }

    expect(respuesta.headers.get("X-Frame-Options")).toBe("DENY");
    expect(respuesta.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(respuesta.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("el nonce cambia en cada pedido", () => {
    const nonce = (respuesta: Response) =>
      /'nonce-([0-9a-f]{32})'/.exec(respuesta.headers.get("Content-Security-Policy") ?? "")?.[1];

    const a = nonce(proxy(new NextRequest("http://localhost/ingresar")));
    const b = nonce(proxy(new NextRequest("http://localhost/ingresar")));

    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("anti-CSRF", () => {
  const HOST = "imperiorp-staff.vercel.app";
  const escritura = (cambios: { origin?: string | null; referer?: string | null }) =>
    isSameOrigin({ method: "POST", origin: null, referer: null, host: HOST, ...cambios });

  it("acepta escrituras del propio sitio", () => {
    expect(escritura({ origin: "https://" + HOST })).toBe(true);
    expect(escritura({ referer: "https://" + HOST + "/pagos" })).toBe(true);
  });

  it("rechaza escrituras de otro sitio, de uno con nombre parecido, o sin origen", () => {
    expect(escritura({ origin: "https://evil.example" })).toBe(false);
    expect(escritura({ origin: "https://" + HOST + ".evil.example" })).toBe(false);
    expect(escritura({ origin: "null" })).toBe(false);
    expect(escritura({ referer: "https://evil.example/" + HOST })).toBe(false);
    expect(escritura({})).toBe(false);
  });

  it("el token de una sesión no sirve para otra, ni recortado, ni retocado", () => {
    const token = csrfTokenFor("sesion-a");
    const retocado = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    expect(verifyCsrfToken("sesion-a", token)).toBe(true);
    expect(verifyCsrfToken("sesion-b", token)).toBe(false);
    expect(verifyCsrfToken("sesion-a", token.slice(0, -1))).toBe(false);
    expect(verifyCsrfToken("sesion-a", retocado)).toBe(false);
    expect(verifyCsrfToken("sesion-a", "")).toBe(false);
    expect(verifyCsrfToken("sesion-a", null)).toBe(false);
  });
});

describe("a dónde manda el login después de entrar", () => {
  const destino = (valor: string) =>
    loginSchema.parse({ username: "pit", password: "x", redirectTo: valor }).redirectTo;

  it.each([
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "/.//evil.example",
    "/pagos\n",
    " /pagos",
  ])("descarta %j", (valor) => {
    expect(destino(valor)).toBeNull();
  });

  it.each(["/pagos", "/staff/123?tab=horas", "/horas?semana=2026-09-07"])("acepta %s", (valor) => {
    expect(destino(valor)).toBe(valor);
  });
});

describe("contraseñas", () => {
  const CLAVE = "Correcta-Imperio-2026";

  it("el mismo texto da hashes distintos, y la incorrecta no pasa", async () => {
    const a = await hashPassword(CLAVE);
    const b = await hashPassword(CLAVE);

    expect(a).not.toBe(b);
    expect((await verifyPassword(CLAVE, a)).valid).toBe(true);
    expect((await verifyPassword(CLAVE + "x", a)).valid).toBe(false);
  });

  it("un hash adulterado no puede pedir memoria sin límite ni pasar recortado", async () => {
    const [algoritmo, version, , sal, clave] = (await hashPassword(CLAVE)).split("$");

    // Un gigabyte de parámetros: tiene que rechazarse sin intentar calcularlo.
    const gigante = [algoritmo, version, "N=1073741824,r=8,p=2", sal, clave].join("$");
    const inicio = Date.now();
    expect((await verifyPassword(CLAVE, gigante)).valid).toBe(false);
    expect(Date.now() - inicio).toBeLessThan(2000);

    const recortado = [algoritmo, version, "N=1024,r=8,p=1", sal, clave?.slice(0, 16)].join("$");
    expect((await verifyPassword(CLAVE, recortado)).valid).toBe(false);
  });
});

describe("roles y permisos", () => {
  it("el auditor sólo mira y exporta", () => {
    for (const permiso of ROLE_DEFINITIONS.AUDITOR.permissions) {
      expect(permiso).toMatch(/\.(view|export)$/);
    }
  });

  it("High Staff no reabre, no anula, no toca cuentas ni configuración", () => {
    for (const permiso of [
      P.WEEKS_REOPEN,
      P.WEEKS_DELETE,
      P.PAYMENTS_VOID,
      P.USERS_CREATE,
      P.USERS_EDIT,
      P.USERS_DELETE,
      P.USERS_RESET_PASSWORD,
      P.USERS_REVOKE_SESSIONS,
      P.SETTINGS_MANAGE,
      P.SETTINGS_RATES,
      P.SECURITY_VIEW,
      P.DATA_IMPORT,
    ]) {
      expect(hasPermission({ role: "HIGH_STAFF" }, permiso), permiso).toBe(false);
    }
  });

  it("un encargado carga horas, pero no paga ni cambia rangos", () => {
    const encargado = { role: "MANAGER" };
    expect(hasPermission(encargado, P.HOURS_CREATE)).toBe(true);
    expect(hasPermission(encargado, P.PAYMENTS_CREATE)).toBe(false);
    expect(hasPermission(encargado, P.STAFF_CHANGE_RANK)).toBe(false);
  });

  it("un rol inventado no tiene nada, y un permiso inventado no se suma", () => {
    expect(effectivePermissions({ role: "ADMIN" }).size).toBe(0);
    expect(hasPermission({ role: "ADMIN", grantedPermissions: ["*", "todo"] }, P.STAFF_VIEW)).toBe(
      false,
    );
    expect(effectivePermissions({ role: "AUDITOR", grantedPermissions: ["users.todo"] })).toEqual(
      effectivePermissions({ role: "AUDITOR" }),
    );
  });

  it("un permiso revocado le gana a uno concedido", () => {
    const usuario = {
      role: "MANAGER",
      grantedPermissions: [P.PAYMENTS_VOID],
      revokedPermissions: [P.PAYMENTS_VOID],
    };
    expect(hasPermission(usuario, P.PAYMENTS_VOID)).toBe(false);
  });

  it("nadie administra a alguien de su mismo nivel o de uno mayor", () => {
    expect(canManageRole("HIGH_STAFF", "HIGH_STAFF")).toBe(false);
    expect(canManageRole("HIGH_STAFF", "OWNER")).toBe(false);
    expect(canManageRole("OWNER", "OWNER")).toBe(false);
    expect(canManageRole("OWNER", "FOUNDER")).toBe(false);
    expect(canManageRole("FOUNDER", "OWNER")).toBe(true);
    expect(canManageRole("INVENTADO", "AUDITOR")).toBe(false);
    expect(canManageRole("FOUNDER", "INVENTADO")).toBe(false);
  });
});

describe("los logs", () => {
  it("no escriben contraseñas, tokens ni cookies, aunque vengan anidados", () => {
    const salida = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logger.warn("prueba", {
      password: "clave-visible-1",
      pedido: {
        headers: { Authorization: "Bearer secreto-visible-2", cookie: "sesion-visible-3" },
      },
      intentos: [{ newPassword: "clave-visible-4", token: "token-visible-5" }],
    });

    const texto = salida.mock.calls.flat().join("\n");
    for (const secreto of [
      "clave-visible-1",
      "secreto-visible-2",
      "sesion-visible-3",
      "clave-visible-4",
      "token-visible-5",
    ]) {
      expect(texto).not.toContain(secreto);
    }
    expect(texto).toContain("[redactado]");
  });
});

describe("el secreto de las tareas programadas", () => {
  it("compara todo el texto, no un pedazo", () => {
    expect(coincideSecreto("abc123", "abc123")).toBe(true);
    expect(coincideSecreto("abc124", "abc123")).toBe(false);
    expect(coincideSecreto("abc12", "abc123")).toBe(false);
    expect(coincideSecreto("abc1234", "abc123")).toBe(false);
    expect(coincideSecreto(null, "abc123")).toBe(false);
    expect(coincideSecreto("", "")).toBe(false);
  });

  it("sin secreto configurado no autoriza a nadie", () => {
    expect(portadorValido("Bearer s3cr3t", "s3cr3t")).toBe(true);
    expect(portadorValido("Bearer s3cr3t", undefined)).toBe(false);
    expect(portadorValido("Bearer ", "")).toBe(false);
    expect(portadorValido("s3cr3t", "s3cr3t")).toBe(false);
    expect(portadorValido(null, "s3cr3t")).toBe(false);
  });
});

describe("la marca de navegador conocido", () => {
  const OTRO_ID = "22222222-2222-4222-8222-222222222222";
  const cuenta = {
    id: "11111111-1111-4111-8111-111111111111",
    passwordChangedAt: new Date("2026-09-01T12:00:00Z"),
  };

  it("vale para su cuenta y para ninguna otra", () => {
    const marca = marcaDeDispositivo(cuenta);

    expect(esMarcaValida(marca, cuenta)).toBe(true);
    expect(esMarcaValida(marca, { ...cuenta, id: OTRO_ID })).toBe(false);
    expect(esMarcaValida(marca.replace(cuenta.id, OTRO_ID), { ...cuenta, id: OTRO_ID })).toBe(
      false,
    );
    expect(esMarcaValida(marca.slice(0, -2) + "zz", cuenta)).toBe(false);
    expect(esMarcaValida(null, cuenta)).toBe(false);
  });

  it("cambiar la contraseña invalida las marcas anteriores", () => {
    const vieja = marcaDeDispositivo(cuenta);
    const despues = { ...cuenta, passwordChangedAt: new Date("2026-09-10T12:00:00Z") };

    expect(esMarcaValida(vieja, despues)).toBe(false);
  });
});

describe("avisos de pago en Discord", () => {
  it("no dejan sonar @everyone aunque el motivo lo traiga", async () => {
    vi.stubEnv("DISCORD_TOKEN", "token-de-prueba");
    vi.stubEnv("DISCORD_PAGOS", "123456789012345678");

    const cuerpos: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        cuerpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "999999999999999999" }), { status: 200 });
      }),
    );

    const aviso = {
      staffName: "Martin",
      rank: "MOD",
      amount: 150_000,
      minutes: 600,
      period: "07/09 al 13/09",
      actor: "pit",
      voided: true,
      reason: "@everyone se pagó dos veces",
    };
    await notifyPayment(aviso);
    await notifyPaymentsPrivately([{ ...aviso, discordUserId: "111111111111111111" }]);

    // Canal de pagos, apertura del privado y mensaje privado.
    expect(cuerpos).toHaveLength(3);
    const mensajes = cuerpos.filter((cuerpo) => "components" in cuerpo);
    expect(mensajes).toHaveLength(2);
    for (const mensaje of mensajes) {
      expect(mensaje.allowed_mentions).toEqual({ parse: [] });
    }
  });
});
