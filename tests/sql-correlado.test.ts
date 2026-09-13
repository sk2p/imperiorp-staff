import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardia contra subconsultas correlacionadas mal escritas.
 *
 * El ORM, cuando la consulta tiene una sola tabla, escribe las columnas SIN
 * calificar: `${weeks.id}` sale como `"id"` pelado. Adentro de una subconsulta
 * sobre otra tabla que también tiene una columna `id` —y casi todas la
 * tienen—, ese nombre suelto se resuelve contra la tabla de adentro. El SQL es
 * válido, la base no protesta, y la comparación no encuentra nunca nada: todos
 * los totales dan cero.
 *
 * Así estuvo la página de períodos mostrando 0 horas y $0 en cada fila.
 *
 * La regla: una plantilla de consulta que abre una subconsulta no puede
 * correlacionar con una columna interpolada. La tabla de afuera se nombra a
 * mano y calificada —`"weeks"."id"`—, que es inequívoco pase lo que pase.
 */

const RAIZ = path.resolve(import.meta.dirname, "../src/server");

function archivosTs(directorio: string): string[] {
  return readdirSync(directorio, { withFileTypes: true }).flatMap((entrada) => {
    const completo = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) return archivosTs(completo);
    return entrada.name.endsWith(".ts") ? [completo] : [];
  });
}

const COMILLA = "`";

/**
 * Cada plantilla de consulta del archivo, con su número de línea.
 *
 * Reconoce `sql` y también las tipadas, `sql<number>` y compañía. La primera
 * versión de esto buscaba el nombre a secas y se le escapaban justamente las
 * tipadas, que son la mayoría de las que devuelven un número. Un guardia con un
 * punto ciego es peor que no tener guardia: da la tranquilidad sin dar la
 * protección.
 */
function plantillas(fuente: string): { linea: number; texto: string }[] {
  const encontradas: { linea: number; texto: string }[] = [];
  const patron = /sql(?:<[^>]*>)?[`]/g;
  let desde = 0;

  for (;;) {
    patron.lastIndex = desde;
    const encontrado = patron.exec(fuente);
    if (encontrado === null) break;

    const abre = encontrado.index;

    // El cierre es la primera comilla invertida sin escapar después del inicio.
    let cursor = abre + encontrado[0].length;
    while (cursor < fuente.length && !(fuente[cursor] === COMILLA && fuente[cursor - 1] !== "\\")) {
      cursor += 1;
    }

    encontradas.push({
      linea: fuente.slice(0, abre).split("\n").length,
      texto: fuente.slice(abre, cursor),
    });
    desde = cursor + 1;
  }

  return encontradas;
}

describe("subconsultas correlacionadas", () => {
  it("el guardia encuentra las plantillas que tiene que revisar", () => {
    /**
     * Este caso existe porque el guardia ya se rompió una vez: un carácter mal
     * escapado dejó la expresión regular sin coincidir con nada, y el test
     * siguió pasando en verde sobre una lista vacía. Un guardia que no mira
     * nada aprueba todo.
     */
    const total = archivosTs(RAIZ).reduce(
      (suma, archivo) => suma + plantillas(readFileSync(archivo, "utf8")).length,
      0,
    );

    expect(total).toBeGreaterThan(20);
  });

  it("ninguna correlaciona con una columna interpolada por el ORM", () => {
    const sospechosas: string[] = [];

    for (const archivo of archivosTs(RAIZ)) {
      const fuente = readFileSync(archivo, "utf8");

      for (const { linea, texto } of plantillas(fuente)) {
        // Sólo interesan las que abren una subconsulta con su propia tabla.
        if (!/\(\s*select\b/is.test(texto)) continue;

        /**
         * Interpolar un valor —`${weekId}::uuid`— es correcto: viaja como
         * parámetro. Lo que rompe es interpolar una COLUMNA, que el ORM
         * convierte en un identificador desnudo. Se reconocen por el punto:
         * `${tabla.columna}`.
         */
        const columnas = texto.match(/\$\{\s*[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\}/g) ?? [];
        const correlaciones = columnas.filter((referencia) => !/\bsql\./.test(referencia));

        if (correlaciones.length > 0) {
          sospechosas.push(
            path.relative(RAIZ, archivo) + ":" + linea + " → " + correlaciones.join(", "),
          );
        }
      }
    }

    expect(sospechosas).toEqual([]);
  });
});
