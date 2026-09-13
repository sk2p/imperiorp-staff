import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nada de Node en el JavaScript del navegador.
 *
 * Un componente del navegador importaba el nombre del campo anti-CSRF desde
 * `lib/auth/csrf.ts`. Ese archivo también importa `node:crypto` para firmar el
 * token, y el empaquetador, para que eso "funcione" en el navegador, metía la
 * emulación de `crypto` de Node completa: `crypto-browserify`, `vm-browserify`
 * y una cadena de dependencias. El archivo resultante pesaba 862 KB, lo bajaba
 * cada teléfono en cada carga, y traía código que arma funciones a partir de
 * texto. La política de seguridad de la página lo bloqueaba y Chrome lo marcaba
 * como problema en todas las pantallas.
 *
 * Nadie lo vio venir porque no rompe nada: la página anda igual. Por eso este
 * test recorre, desde cada componente `"use client"`, todo lo que importa y lo
 * que importa eso, y falla si en algún punto aparece un módulo de Node.
 *
 * Dos detalles para no dar falsas alarmas:
 *   · `import type` se borra al compilar: no llega al navegador.
 *   · Un archivo `"use server"` (las acciones) llega al navegador sólo como una
 *     referencia; su código y lo que importa se quedan en el servidor.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

/** Los módulos propios de Node que no existen en un navegador. */
const NUCLEO = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "querystring",
  "stream",
  "tls",
  "url",
  "util",
  "vm",
  "worker_threads",
  "zlib",
]);

const COMENTARIOS_INICIALES = String.raw`^(?:\s|//[^\n]*\n|/\*[\s\S]*?\*/)*`;
const DIRECTIVA_CLIENTE = new RegExp(COMENTARIOS_INICIALES + `["']use client["']`);
const DIRECTIVA_SERVIDOR = new RegExp(COMENTARIOS_INICIALES + `["']use server["']`);

/**
 * `import … from "x"`, `import "x"`, `export … from "x"`. El primer grupo marca
 * los de sólo tipos. El cuerpo no cruza un punto y coma, así un `export` sin
 * `from` no se come la sentencia siguiente.
 */
const IMPORTS = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;

function archivos(directorio: string): string[] {
  return readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const completo = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivos(completo);
    return /\.tsx?$/.test(entrada.name) ? [completo] : [];
  });
}

function resolver(desde: string, especificador: string): string | null {
  const base = especificador.startsWith("@/")
    ? path.join(SRC, especificador.slice(2))
    : especificador.startsWith(".")
      ? path.resolve(path.dirname(desde), especificador)
      : null;
  if (!base) return null;

  const candidatos = [
    base,
    base + ".ts",
    base + ".tsx",
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidatos.find((candidato) => /\.tsx?$/.test(candidato) && existsSync(candidato)) ?? null;
}

const relativo = (archivo: string) => path.relative(SRC, archivo).replaceAll("\\", "/");

/** Todo lo que llega a Node partiendo de un archivo, con el camino de imports. */
function modulosDeNode(entrada: string): string[] {
  const problemas = new Set<string>();
  const cola = [{ archivo: entrada, camino: [relativo(entrada)] }];
  const vistos = new Set<string>();

  while (cola.length > 0) {
    const { archivo, camino } = cola.shift()!;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);

    const fuente = readFileSync(archivo, "utf8");
    if (archivo !== entrada && DIRECTIVA_SERVIDOR.test(fuente)) continue;

    for (const coincidencia of fuente.matchAll(IMPORTS)) {
      if (coincidencia[1]) continue;
      const especificador = coincidencia[2]!;
      const nombre = especificador.replace(/^node:/, "").split("/")[0]!;

      if (especificador.startsWith("node:") || NUCLEO.has(nombre)) {
        problemas.add(camino.join(" → ") + " → " + especificador);
        continue;
      }

      const destino = resolver(archivo, especificador);
      if (destino) cola.push({ archivo: destino, camino: [...camino, relativo(destino)] });
    }
  }

  return [...problemas];
}

describe("el JavaScript del navegador", () => {
  it("el guardia detecta de verdad un módulo de Node", () => {
    /**
     * Este test se escribió después de arreglar el problema, así que pasar en
     * verde no alcanza para saber que lo hubiera visto. `csrf.ts` importa
     * `node:crypto` a propósito —es código de servidor—: tratado como si fuera
     * un componente del navegador, el guardia TIENE que marcarlo.
     */
    const csrf = path.join(SRC, "lib/auth/csrf.ts");
    expect(modulosDeNode(csrf)).toContain("lib/auth/csrf.ts → node:crypto");
  });

  it("no arrastra módulos de Node desde ningún componente cliente", () => {
    const clientes = archivos(SRC).filter((archivo) =>
      DIRECTIVA_CLIENTE.test(readFileSync(archivo, "utf8")),
    );

    // Si la detección se rompe y no encuentra componentes, el test pasaría en
    // verde sin mirar nada.
    expect(clientes.length).toBeGreaterThan(10);

    expect(clientes.flatMap(modulosDeNode)).toEqual([]);
  });
});
