import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardias sobre el código fuente.
 *
 * Los otros tests de seguridad prueban las barreras que existen. Estos
 * vigilan que no aparezca una puerta nueva sin barrera: una acción del
 * servidor sin chequeo de sesión, una ruta de la API que le contesta a
 * cualquiera, HTML sin escapar, una variable secreta leída desde el navegador.
 *
 * Nadie escribe eso a propósito. Aparece un día apurado, y como la página
 * anda igual, nadie lo ve. Estas pruebas lo ven.
 */

const RAIZ = path.resolve(import.meta.dirname, "..");
const SRC = path.join(RAIZ, "src");

function archivos(directorio: string): string[] {
  return readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const completo = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivos(completo);
    return /\.tsx?$/.test(entrada.name) ? [completo] : [];
  });
}

const leer = (archivo: string) => readFileSync(archivo, "utf8");
const relativo = (archivo: string) => path.relative(SRC, archivo).replaceAll("\\", "/");

/** Sin comentarios: que una explicación nombre `requireAuth(` no cuenta como chequeo. */
const sinComentarios = (fuente: string) =>
  fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TODOS = archivos(SRC);

/* -------------------------------------------------------------------------- */
/* Acciones del servidor                                                      */
/* -------------------------------------------------------------------------- */

/**
 * En un archivo `"use server"`, CADA función exportada se puede llamar desde el
 * navegador con un POST, esté o no en algún botón. Si no verifica la sesión
 * ella misma, no la verifica nadie.
 */
const CONTROL_DE_SESION =
  /\b(runAction|requireAuth|requirePermission|requireAnyPermission|requireFounder|requireOwner)\(/;

/** La única que tiene que poder usarse sin sesión: la de entrar. */
const ACCIONES_SIN_SESION = new Set(["loginAction"]);

function accionesSinControl(fuente: string): string[] {
  return sinComentarios(fuente)
    .split(/\nexport async function /)
    .slice(1)
    .map((trozo) => ({ nombre: trozo.slice(0, trozo.indexOf("(")), cuerpo: trozo }))
    .filter(
      ({ nombre, cuerpo }) => !ACCIONES_SIN_SESION.has(nombre) && !CONTROL_DE_SESION.test(cuerpo),
    )
    .map(({ nombre }) => nombre);
}

describe("acciones del servidor", () => {
  const ACCIONES = path.join(SRC, "server/actions/index.ts");

  it("hay un solo archivo de acciones, y es el que está vigilado", () => {
    const conDirectiva = TODOS.filter((archivo) => /["']use server["']/.test(leer(archivo)));
    expect(conDirectiva.map(relativo)).toEqual(["server/actions/index.ts"]);
  });

  it("el guardia detecta de verdad una acción sin chequeo", () => {
    // Escrito después de revisar el archivo real: pasar en verde no alcanza para
    // saber que lo hubiera visto. Esta acción inventada TIENE que marcarse.
    const falsa =
      '"use server";\n\n' +
      "export async function borrarTodo() {\n  return db.delete(users);\n}\n\n" +
      "export async function conSesion(formData) {\n  return runAction(formData, {}, async () => {});\n}\n";

    expect(accionesSinControl(falsa)).toEqual(["borrarTodo"]);
  });

  it("cada acción exportada pasa por el chequeo de sesión", () => {
    const fuente = leer(ACCIONES);

    expect(fuente.split(/\nexport async function /).length - 1).toBeGreaterThan(20);
    expect(accionesSinControl(fuente)).toEqual([]);
  });

  it("no exporta nada que no sea una acción", () => {
    expect(leer(ACCIONES).match(/^export (?!async function )/gm) ?? []).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Rutas de la API                                                            */
/* -------------------------------------------------------------------------- */

describe("rutas de la API", () => {
  const CONTROL =
    /\b(getCurrentSession|getAuthContext|requireAuth|requirePermission|requireFounder|requireOwner|portadorValido)\(/;

  /** Públicas a propósito. Cada una tiene que poder justificarse en una línea. */
  const PUBLICAS = new Set([
    // Sonda de vida del hosting: no toca la base ni dice nada interno.
    "app/api/health/route.ts",
  ]);

  const rutas = archivos(path.join(SRC, "app/api"))
    .filter((archivo) => archivo.endsWith("route.ts"))
    .map(relativo);

  it("cada ruta verifica sesión o secreto, salvo las declaradas públicas", () => {
    expect(rutas.length).toBeGreaterThan(5);

    const sinControl = rutas
      .filter((ruta) => !PUBLICAS.has(ruta))
      .filter((ruta) => !CONTROL.test(sinComentarios(leer(path.join(SRC, ruta)))));

    expect(sinControl).toEqual([]);
  });

  it("las públicas no tocan la base ni los servicios", () => {
    for (const ruta of PUBLICAS) {
      expect(leer(path.join(SRC, ruta))).not.toMatch(/from "@\/(db|server)/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Inyección                                                                  */
/* -------------------------------------------------------------------------- */

describe("inyección", () => {
  it("nadie mete HTML crudo en React", () => {
    const conHtml = TODOS.filter((archivo) => leer(archivo).includes("dangerouslySetInnerHTML"));
    expect(conHtml.map(relativo)).toEqual([]);
  });

  it("sql.raw sólo en los lugares revisados, que arman el texto con constantes", () => {
    const REVISADOS = ["db/backup.ts", "db/verify-backup.ts", "server/firma.ts", "server/weeks.ts"];
    const conRaw = TODOS.filter((archivo) => leer(archivo).includes("sql.raw(")).map(relativo);

    expect(conRaw.sort()).toEqual(REVISADOS);
  });
});

/* -------------------------------------------------------------------------- */
/* Navegador y secretos                                                       */
/* -------------------------------------------------------------------------- */

describe("secretos", () => {
  it("ningún componente del navegador lee variables de entorno del servidor", () => {
    const DIRECTIVA = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;

    const problemas = TODOS.filter((archivo) => DIRECTIVA.test(leer(archivo))).flatMap((archivo) =>
      [...leer(archivo).matchAll(/process\.env\.([A-Z0-9_]+)/g)]
        .map((coincidencia) => coincidencia[1] ?? "")
        .filter((nombre) => nombre !== "NODE_ENV" && !nombre.startsWith("NEXT_PUBLIC_"))
        .map((nombre) => relativo(archivo) + " → " + nombre),
    );

    expect(problemas).toEqual([]);
  });

  it("ninguna variable pública (NEXT_PUBLIC_) lleva un secreto", () => {
    const publicas = TODOS.flatMap((archivo) =>
      [...leer(archivo).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map((coincidencia) => coincidencia[0]),
    );

    expect(
      publicas.filter((nombre) => /SECRET|TOKEN|KEY|PASS|WEBHOOK|DATABASE/.test(nombre)),
    ).toEqual([]);
  });

  it("el repositorio no tiene .env, copias de la base ni el bot compilado", () => {
    const seguidos = execFileSync("git", ["ls-files"], { cwd: RAIZ, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);

    expect(seguidos.length).toBeGreaterThan(50);
    expect(
      seguidos.filter((archivo) =>
        /^\.env($|\.(?!example$))|^copias\/|^dist-bot\/|^\.pglite_data\//.test(archivo),
      ),
    ).toEqual([]);
  });

  it(".gitignore los sigue dejando afuera", () => {
    const reglas = leer(path.join(RAIZ, ".gitignore")).split(/\r?\n/);

    for (const regla of [".env", ".env.prueba", "copias/", "dist-bot/", ".pglite_data/"]) {
      expect(reglas).toContain(regla);
    }
  });
});
