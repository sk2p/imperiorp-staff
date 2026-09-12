import Image from "next/image";

/**
 * El escudo, como una moneda de verdad.
 *
 * No es una imagen con sombra ni un truco de dos capas: es un sólido armado en
 * el espacio. Dos caras enfrentadas separadas por el grosor, y un canto que se
 * construye con rebanadas planas paradas alrededor del borde, como las duelas
 * de un barril. Al girar se ve el canto, se ve el reflejo correrse por él, y la
 * cara de atrás aparece invertida igual que giraría una moneda en la mano.
 *
 * Todo esto es CSS. La alternativa era traer una librería 3D —medio megabyte
 * de JavaScript, un contexto WebGL, un bucle de render— para hacer girar un
 * escudo en la pantalla de ingreso. El navegador ya sabe componer planos en
 * perspectiva y lo hace en la placa de video sin ejecutar una sola línea de
 * código nuestro.
 *
 * `REBANADAS` es de cuántos planos se arma el canto. Con pocos se ve el
 * polígono; con muchos es DOM al pedo. Veinticuatro es donde deja de notarse.
 */
const REBANADAS = 24;

export function Coin({
  size = 128,
  className,
  priority = false,
  girar = true,
}: {
  readonly size?: number;
  readonly className?: string;
  readonly priority?: boolean;
  /**
   * `false` la deja quieta y sólo gira al pasarle por encima. Es lo que
   * corresponde en la barra lateral: algo girando todo el tiempo al costado de
   * la pantalla, ocho horas por día, deja de ser lindo y pasa a molestar.
   */
  readonly girar?: boolean;
}) {
  return (
    <div
      className={"moneda " + (girar ? "" : "moneda-en-reposo ") + (className ?? "")}
      style={{ "--moneda-tam": size + "px" } as React.CSSProperties}
      aria-hidden
    >
      <div className="moneda-cuerpo">
        <div className="moneda-cara moneda-frente">
          <Image src="/imperiorplogo.webp" alt="" width={size} height={size} priority={priority} />
        </div>

        <div className="moneda-cara moneda-dorso">
          <Image src="/imperiorplogo.webp" alt="" width={size} height={size} />
        </div>

        {Array.from({ length: REBANADAS }, (_, indice) => (
          <span
            key={indice}
            className="moneda-duela"
            style={{ "--duela": indice } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
