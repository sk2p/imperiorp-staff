import { Fragment, type CSSProperties } from "react";

/**
 * Los números caen en su lugar, como el rodillo de una caja registradora.
 *
 * Cada carácter entra girando sobre su eje horizontal, uno detrás del otro. No
 * es un contador que sube: un contador que sube obliga a mirar cómo termina
 * antes de poder leer el número, y esta gente abre la página para leer una
 * cifra, no para esperarla. Acá el valor final está escrito desde el primer
 * cuadro; lo único que se anima es cómo aparece.
 *
 * Sin JavaScript. Son `span` con un retardo calculado en CSS, así que el
 * número también está completo y legible para un lector de pantalla o si el
 * navegador nunca llega a animar nada.
 */
export function Rodillo({
  texto,
  className,
  /** Milisegundos entre un carácter y el siguiente. */
  paso = 38,
}: {
  readonly texto: string;
  readonly className?: string;
  readonly paso?: number;
}) {
  /**
   * Se agrupa por palabras y no carácter por carácter suelto.
   *
   * Si cada letra fuera su propia caja independiente, el navegador podría
   * cortar el renglón en cualquier lado: "$818" arriba y "200.000" abajo, o
   * peor, "18/0" y "9". Agrupadas, adentro de una palabra no hay dónde
   * cortar, y entre palabras queda el espacio de siempre. Se parte donde se
   * partiría cualquier texto.
   */
  const palabras = texto.split(" ");
  let posicion = 0;

  return (
    <span className={"rodillo " + (className ?? "")}>
      {/* El texto entero para quien lee con voz; los trozos animados quedan
          ocultos a la accesibilidad para que no se deletree cifra por cifra. */}
      <span className="sr-only">{texto}</span>

      <span aria-hidden className="rodillo-pista">
        {palabras.map((palabra, indicePalabra) => (
          <Fragment key={indicePalabra}>
            {/* El espacio va suelto, fuera de la palabra: ahí y sólo ahí puede
                cortar el renglón. */}
            {indicePalabra > 0 ? " " : null}
            <span className="rodillo-palabra">
              {[...palabra].map((caracter, indice) => (
                <span
                  key={indice}
                  className="rodillo-cifra"
                  style={{ animationDelay: posicion++ * paso + "ms" } as CSSProperties}
                >
                  {caracter}
                </span>
              ))}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}
