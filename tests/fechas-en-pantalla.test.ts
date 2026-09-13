import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ninguna fecha se formatea sin decir en qué zona horaria.
 *
 * `fecha.toLocaleString("es-AR")` no usa la zona de Argentina: usa la del
 * PROCESO. En la máquina de uno eso da bien por casualidad, y en Vercel el
 * proceso corre en UTC. El resultado es que todo lo que tiene hora —el
 * registro de auditoría, el último ingreso, la fecha de un pago— se mostraba
 * tres horas corrido, y un pago hecho a las 21:30 aparecía con la fecha del
 * día siguiente.
 *
 * Peor todavía en un componente del navegador: el servidor escribe la hora en
 * su zona, el navegador la escribe en la del usuario, los dos textos no
 * coinciden y React tira la página entera al piso. Así se perdía el JavaScript
 * de "Mi cuenta", que es justo la pantalla donde se cierran las sesiones
 * cuando uno sospecha que alguien entró.
 *
 * La regla: las fechas se formatean con los ayudantes de `domain/clock`, que
 * llevan la zona de la aplicación adentro. Formatear NÚMEROS con
 * `toLocaleString("es-AR")` —sin opciones— sigue estando bien: ahí no hay
 * ninguna zona horaria en juego.
 */

const RAICES = [
  path.resolve(import.meta.dirname, "../src/app"),
  path.resolve(import.meta.dirname, "../src/components"),
];

function archivos(directorio: string): string[] {
  return readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const completo = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivos(completo);
    return /\.tsx?$/.test(entrada.name) ? [completo] : [];
  });
}

describe("fechas en pantalla", () => {
  it("ninguna se formatea con la zona horaria del proceso", () => {
    const sospechosas: string[] = [];

    for (const raiz of RAICES) {
      for (const archivo of archivos(raiz)) {
        const lineas = readFileSync(archivo, "utf8").split("\n");

        lineas.forEach((linea, indice) => {
          /**
           * `toLocaleDateString` y `toLocaleTimeString` son siempre fechas.
           * `toLocaleString` puede ser un número, y sólo delata si le pasan
           * opciones de fecha.
           */
          const esFecha =
            /\.toLocaleDateString\s*\(/.test(linea) ||
            /\.toLocaleTimeString\s*\(/.test(linea) ||
            /\.toLocaleString\s*\([^)]*,\s*\{/.test(linea);

          if (!esFecha) return;

          // Con `timeZone` explícito está resuelto, aunque sea a mano.
          if (/timeZone/.test(linea)) return;

          sospechosas.push(
            path.relative(path.resolve(import.meta.dirname, ".."), archivo) +
              ":" +
              (indice + 1) +
              " → " +
              linea.trim().slice(0, 70),
          );
        });
      }
    }

    expect(sospechosas).toEqual([]);
  });
});
