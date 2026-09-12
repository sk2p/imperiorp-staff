import type { CSSProperties } from "react";

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
  const caracteres = [...texto];

  return (
    <span className={"rodillo " + (className ?? "")}>
      {/* El texto completo para quien lee con voz; los trozos animados quedan
          ocultos a la accesibilidad para que no se deletree cifra por cifra. */}
      <span className="sr-only">{texto}</span>

      <span aria-hidden className="rodillo-pista">
        {caracteres.map((caracter, indice) => (
          <span
            key={indice}
            className="rodillo-cifra"
            style={{ animationDelay: indice * paso + "ms" } as CSSProperties}
          >
            {caracter === " " ? "\u00a0" : caracter}
          </span>
        ))}
      </span>
    </span>
  );
}
