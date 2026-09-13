import type { CSSProperties } from "react";

/**
 * Anillo de avance con volumen.
 *
 * Para "cuánto de la liquidación ya se pagó". Una barra de progreso dice lo
 * mismo, pero en la tarjeta del Inicio competía con las barritas del ranking de
 * al lado y se perdía entre ellas; un anillo se lee de un vistazo y no se
 * confunde con nada.
 *
 * El volumen es el mismo recurso que las barras del gráfico: el aro repetido
 * un poco más abajo y en sombra hace de canto, y un filo de luz arriba lo
 * despega del fondo. Todo SVG dibujado en el servidor: cero JavaScript.
 */

const RADIO = 46;
const VUELTA = 2 * Math.PI * RADIO;

export function RingMeter({
  value,
  total,
  label,
  caption,
  size = 124,
}: {
  readonly value: number;
  readonly total: number;
  /** Lo que lee un lector de pantalla: la frase completa. */
  readonly label: string;
  /** Lo que va escrito adentro del anillo: una o dos palabras. */
  readonly caption: string;
  readonly size?: number;
}) {
  const porcentaje = total <= 0 ? 0 : Math.min(100, Math.round((value / total) * 100));
  const resto = VUELTA * (1 - porcentaje / 100);

  return (
    <div
      className="anillo shrink-0"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={porcentaje}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <svg viewBox="0 0 120 120" className="anillo-lienzo" aria-hidden>
        <defs>
          <linearGradient id="anillo-relleno" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#86efc4" />
            <stop offset="100%" stopColor="var(--color-jade-500)" />
          </linearGradient>
          <radialGradient id="anillo-cupula" cx="50%" cy="28%" r="72%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* El canto: el mismo aro, corrido hacia abajo y en sombra. */}
        <circle
          cx="60"
          cy="64.5"
          r={RADIO}
          fill="none"
          stroke="#000000"
          strokeOpacity="0.5"
          strokeWidth="12"
        />

        {/* La canaleta por donde corre el avance. */}
        <circle
          cx="60"
          cy="60"
          r={RADIO}
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.06"
          strokeWidth="12"
        />

        {/* Con cero no se dibuja: la punta redondeada dejaría un punto verde
            que parece un pago que no existe. */}
        {porcentaje > 0 ? (
          <circle
            cx="60"
            cy="60"
            r={RADIO}
            fill="none"
            stroke="url(#anillo-relleno)"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={VUELTA.toFixed(2)}
            strokeDashoffset={resto.toFixed(2)}
            transform="rotate(-90 60 60)"
            className="anillo-avance"
            style={{ "--anillo-vuelta": VUELTA.toFixed(2) } as CSSProperties}
          />
        ) : null}

        {/* Filo de luz sobre el borde y una cúpula tenue en el centro. */}
        <circle
          cx="60"
          cy="60"
          r={RADIO + 6.5}
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.07"
          strokeWidth="1"
        />
        <circle cx="60" cy="60" r="36" fill="url(#anillo-cupula)" />
      </svg>

      <div className="anillo-centro">
        <span className="tnum text-chalk-50 text-2xl leading-none font-bold">{porcentaje}%</span>
        <span className="text-chalk-500 mt-1 text-[0.5625rem] font-semibold tracking-[0.14em] uppercase">
          {caption}
        </span>
      </div>
    </div>
  );
}
