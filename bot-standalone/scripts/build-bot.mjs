import { build } from "esbuild";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * IMPERIO RP — Empaqueta el bot en un solo archivo para subirlo a un host.
 *
 * Hasta ahora el bot se corría con `tsx`, que compila el TypeScript en vivo
 * cada vez que arranca. Sirve en tu máquina y es un mal negocio en un host
 * chico: medido, el arranque con `tsx` pica en 265 MB de memoria contra los
 * 120 MB en que se queda después. En un plan de 512 MB, ese pico se come la
 * mitad del presupuesto por unos segundos, y para nada — el resultado de esa
 * compilación es siempre el mismo.
 *
 * Esto lo compila una vez, acá, y deja un `.js` que el host arranca directo.
 *
 * Qué NO se empaqueta adentro: las dependencias. Van aparte, instaladas por el
 * host con su propio `package.json`. Meter `discord.js` adentro del bundle es
 * pelearse con sus cargas dinámicas y con los binarios nativos del driver de
 * base de datos; se gana poco y se rompe fácil.
 *
 * Uso:
 *   pnpm bot:build
 *   → dist-bot/bot.js  +  dist-bot/package.json
 *
 * Para subirlo: esa carpeta más tu `.env`. En el host, `npm install` y
 * `node bot.js`.
 */

const RAIZ = path.resolve(import.meta.dirname, "..");
const SALIDA = path.join(RAIZ, "dist-bot");

const paquete = JSON.parse(
  await import("node:fs/promises").then((fs) =>
    fs.readFile(path.join(RAIZ, "package.json"), "utf8"),
  ),
);

/**
 * Lo que queda afuera del bundle y se instala en el host.
 *
 * Son las que tienen partes nativas o cargan archivos por su cuenta en tiempo
 * de ejecución. Empaquetarlas rompe de formas difíciles de diagnosticar —y a
 * las tres de la mañana, cuando el bot no arrancó, nadie quiere diagnosticar.
 */
const EXTERNAS = [
  "discord.js",
  "pg",
  "@neondatabase/serverless",
  "ws",
  "@electric-sql/pglite",
  "drizzle-orm",
  "zod",
  "exceljs",
];

await rm(SALIDA, { recursive: true, force: true });

const resultado = await build({
  entryPoints: [path.join(RAIZ, "src/bot/index.ts")],
  outfile: path.join(SALIDA, "bot.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  minify: false,
  external: EXTERNAS,
  // El alias `@/` del proyecto, que esbuild no conoce por su cuenta.
  alias: { "@": path.join(RAIZ, "src") },
  // `import.meta.dirname` y compañía necesitan saber que esto es un módulo.
  banner: {
    js: [
      "import { createRequire as __crear } from 'node:module';",
      "const require = __crear(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
  metafile: true,
});

/**
 * Un `package.json` mínimo para el host: sólo lo que el bot necesita para
 * arrancar. Sin Next, sin React, sin nada de la página — son doscientos
 * megabytes de dependencias que ahí no pintan nada.
 */
const dependencias = Object.fromEntries(
  EXTERNAS.map((nombre) => [nombre, paquete.dependencies[nombre]]).filter(([, version]) => version),
);

await writeFile(
  path.join(SALIDA, "package.json"),
  JSON.stringify(
    {
      name: "imperio-rp-bot",
      version: paquete.version,
      private: true,
      type: "module",
      main: "bot.js",
      scripts: { start: "node bot.js" },
      dependencies: dependencias,
      engines: { node: ">=22" },
    },
    null,
    2,
  ) + "\n",
);

await writeFile(
  path.join(SALIDA, "LEEME.txt"),
  [
    "Bot de fichajes de Imperio RP — listo para subir",
    "",
    "Qué subir:  esta carpeta entera, más el archivo .env",
    "En el host: npm install  →  node bot.js",
    "",
    "El .env NO está acá a propósito: lleva el token del bot y la",
    "cadena de conexión a la base. Se carga aparte, en el panel del host.",
    "",
    "Memoria esperada: unos 90 MB en reposo, con un pico de ~220 al arrancar.",
    "",
    "Generado por: pnpm bot:build",
  ].join("\n") + "\n",
);

const bytes = Object.values(resultado.metafile.outputs).reduce(
  (suma, salida) => suma + salida.bytes,
  0,
);

console.log(
  "\n  dist-bot listo · " +
    (bytes / 1024).toFixed(0) +
    " KB · " +
    Object.keys(dependencias).length +
    " dependencias a instalar en el host\n",
);
