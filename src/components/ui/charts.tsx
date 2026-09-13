import { formatMoneyCompact } from "@/domain/money";
import { formatMinutes } from "@/domain/time";
import { cn } from "./primitives";

/**
 * Gráficos dibujados a mano en SVG.
 *
 * Sin librería de charts: son cuatro formas, se renderizan en el servidor (cero
 * JavaScript enviado al navegador) y quedan exactamente con la tipografía y los
 * colores del resto del sistema, en vez del aspecto reconocible de un paquete
 * de terceros.
 *
 * Criterio de lectura: la escala arranca SIEMPRE en cero. Recortar el eje
 * exagera diferencias y hace que una semana un 3 % mejor parezca el doble.
 */

const AXIS = "rgb(255 255 255 / 0.07)";

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/* -------------------------------------------------------------------------- */
/* Barras                                                                     */
/* -------------------------------------------------------------------------- */

export interface BarDatum {
  readonly label: string;
  readonly value: number;
  readonly secondary?: number;
  readonly highlight?: boolean;
}

export function BarChart({
  data,
  format = "number",
  height = 180,
  secondaryLabel,
}: {
  readonly data: readonly BarDatum[];
  readonly format?: "money" | "minutes" | "number";
  readonly height?: number;
  readonly secondaryLabel?: string;
}) {
  if (data.length === 0) {
    return <p className="text-chalk-600 py-10 text-center text-xs">Sin datos para graficar.</p>;
  }

  const max = niceCeiling(
    Math.max(...data.map((item) => Math.max(item.value, item.secondary ?? 0))),
  );
  const formatValue = (value: number): string =>
    format === "money"
      ? formatMoneyCompact(value)
      : format === "minutes"
        ? formatMinutes(value)
        : value.toLocaleString("es-AR");

  /**
   * Barras con volumen.
   *
   * Cada barra es un prisma: frente, costado y tapa, en tres tonos del mismo
   * color. Da la profundidad de un gráfico en 3D sin perspectiva real, que
   * achica lo que queda al fondo y hace mentir a la escala. Acá el frente de
   * cada barra mide exactamente su valor, desde cero; el volumen va por detrás.
   *
   * Con dos series —generado y pagado— van una al lado de la otra. Superpuestas,
   * como estaban, la de adelante tapaba a la de atrás justo cuando importa
   * compararlas.
   *
   * El lienzo se mide en píxeles de verdad. Con un `viewBox` fijo que se estira
   * para llenar la caja, el costado de un prisma deja de ser paralelo al frente
   * y el ancho de las líneas no coincide entre ejes.
   */
  const conPagado = data.some((item) => item.secondary !== undefined);
  const width = Math.max(360, data.length * 72);
  const slot = width / data.length;
  const ancho = conPagado ? Math.min(20, slot * 0.3) : Math.min(30, slot * 0.5);
  const hondo = Math.max(4, Math.min(9, ancho * 0.42));
  const subida = hondo * 0.6;
  /** Entre los dos prismas de un período: el costado del primero no pisa al segundo. */
  const hueco = hondo + 2;
  const grupo = conPagado ? ancho * 2 + hueco + hondo : ancho + hondo;
  const base = height - 1;
  const alto = height - subida - 8;

  /** La cara que recibe la luz: el tono más claro de cada color. */
  const TAPA = { imperial: "#ff7a86", apagada: "#3b424c", jade: "#86efc4" } as const;

  /** De `[x1, y1, x2, y2, …]` a `"x1,y1 x2,y2 …"`, que es lo que pide `points`. */
  const puntos = (...valores: readonly number[]): string =>
    valores
      .map((valor, indice) => valor.toFixed(1) + (indice % 2 === 0 ? "," : " "))
      .join("")
      .trim();

  const prisma = (x: number, h: number, tono: keyof typeof TAPA) => {
    const arriba = base - h;
    return (
      <>
        <polygon
          points={puntos(
            x + ancho,
            arriba,
            x + ancho + hondo,
            arriba - subida,
            x + ancho + hondo,
            base - subida,
            x + ancho,
            base,
          )}
          fill={"url(#barra-lado-" + tono + ")"}
        />
        <rect x={x} y={arriba} width={ancho} height={h} fill={"url(#barra-" + tono + ")"} />
        <polygon
          points={puntos(
            x,
            arriba,
            x + hondo,
            arriba - subida,
            x + ancho + hondo,
            arriba - subida,
            x + ancho,
            arriba,
          )}
          style={{ fill: TAPA[tono] }}
        />
      </>
    );
  };

  return (
    <figure className="w-full">
      <div className="scroll-x">
        {/* El dibujo y la fila de cifras comparten este ancho exacto. Antes el
            SVG quedaba a su tamaño real, centrado, y las cifras se estiraban a
            lo ancho de toda la tarjeta: cada número caía debajo de otra barra. */}
        <div className="mx-auto" style={{ width, minWidth: width }}>
          <svg
            viewBox={"0 0 " + width + " " + height}
            height={height}
            className="w-full"
            role="img"
            aria-label={"Gráfico de barras con " + data.length + " valores"}
          >
            <defs>
              {/* Frente: se aclara hacia arriba. Costado: el mismo color, en sombra. */}
              <linearGradient id="barra-imperial" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="var(--color-imperial-700)" />
                <stop offset="100%" stopColor="var(--color-imperial-400)" />
              </linearGradient>
              <linearGradient id="barra-lado-imperial" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#3d0510" />
                <stop offset="100%" stopColor="var(--color-imperial-700)" />
              </linearGradient>
              <linearGradient id="barra-apagada" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="var(--color-ink-700)" />
                <stop offset="100%" stopColor="var(--color-ink-600)" />
              </linearGradient>
              <linearGradient id="barra-lado-apagada" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#0c0e12" />
                <stop offset="100%" stopColor="var(--color-ink-800)" />
              </linearGradient>
              <linearGradient id="barra-jade" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="var(--color-jade-500)" />
                <stop offset="100%" stopColor="var(--color-jade-400)" />
              </linearGradient>
              <linearGradient id="barra-lado-jade" x1="0" y1="1" x2="0" y2="0">
                <stop offset="0%" stopColor="#02392b" />
                <stop offset="100%" stopColor="#047857" />
              </linearGradient>
            </defs>

            {/* El piso donde apoyan los prismas: una franja apenas más clara. */}
            <polygon
              points={puntos(
                0,
                base,
                hondo,
                base - subida,
                width,
                base - subida,
                width - hondo,
                base,
              )}
              style={{ fill: "rgb(255 255 255 / 0.03)" }}
            />

            {[0.25, 0.5, 0.75, 1].map((ratio) => (
              <line
                key={ratio}
                x1="0"
                x2={width}
                y1={base - ratio * alto}
                y2={base - ratio * alto}
                stroke={AXIS}
                strokeWidth="1"
              />
            ))}

            {data.map((item, index) => {
              const x = index * slot + (slot - grupo) / 2;
              const barHeight = Math.max(2, (item.value / max) * alto);
              const secondaryHeight =
                item.secondary === undefined ? 0 : Math.max(0, (item.secondary / max) * alto);

              return (
                <g key={item.label + index} className="chart-col">
                  {/* Zona sensible del ancho completo: el puntero no tiene que
                      acertarle a una barra fina para ver el dato. */}
                  <rect x={index * slot} y="0" width={slot} height={height} fill="transparent">
                    <title>
                      {item.label +
                        ": " +
                        formatValue(item.value) +
                        (item.secondary === undefined
                          ? ""
                          : " · pagado " + formatValue(item.secondary))}
                    </title>
                  </rect>

                  <g className="chart-bar" style={{ animationDelay: index * 40 + "ms" }}>
                    {prisma(x, barHeight, item.highlight ? "imperial" : "apagada")}
                  </g>

                  {conPagado && secondaryHeight > 0 ? (
                    <g className="chart-bar" style={{ animationDelay: index * 40 + 120 + "ms" }}>
                      {prisma(x + ancho + hueco, secondaryHeight, "jade")}
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>

          <div className="mt-2 flex" style={{ minWidth: width }}>
            {data.map((item, index) => (
              <div
                key={item.label + index}
                className="min-w-0 flex-1 px-0.5 text-center"
                title={item.label + ": " + formatValue(item.value)}
              >
                <p className="tnum text-chalk-300 truncate text-[0.625rem] font-semibold">
                  {formatValue(item.value)}
                </p>
                <p className="text-chalk-600 truncate text-[0.625rem]">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {secondaryLabel ? (
        <figcaption className="text-chalk-500 mt-3 flex items-center gap-4 text-[0.6875rem]">
          <span className="flex items-center gap-1.5">
            <span className="bg-ink-600 h-2 w-2 rounded-[2px]" />
            Generado
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-jade-500 h-2 w-2 rounded-[2px]" />
            {secondaryLabel}
          </span>
        </figcaption>
      ) : null}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Línea                                                                      */
/* -------------------------------------------------------------------------- */

export function LineChart({
  data,
  format = "number",
  height = 160,
}: {
  readonly data: readonly BarDatum[];
  readonly format?: "money" | "minutes" | "number";
  readonly height?: number;
}) {
  if (data.length < 2) {
    return (
      <p className="text-chalk-600 py-10 text-center text-xs">
        Hacen falta al menos dos períodos para ver una evolución.
      </p>
    );
  }

  const max = niceCeiling(Math.max(...data.map((item) => item.value)));

  // En píxeles reales, igual que las barras: si no, el trazo se ve más grueso
  // en un eje que en el otro y los puntos salen ovalados.
  const width = Math.max(320, data.length * 58);
  const margen = 6;
  const stepX = (width - margen * 2) / (data.length - 1);
  const alto = height - margen * 2;

  const points = data.map((item, index) => ({
    x: margen + index * stepX,
    y: height - margen - (item.value / max) * alto,
  }));

  /**
   * Curva suave en vez de quebrada.
   *
   * Con segmentos rectos, una serie de diez semanas parece un electrocardiograma
   * y los picos se leen más dramáticos de lo que son. La curva usa puntos de
   * control a mitad de camino, así que pasa exactamente por cada valor: suaviza
   * el dibujo sin mover ni un dato.
   */
  const path = points.reduce((acumulado, punto, index) => {
    if (index === 0) return "M" + punto.x.toFixed(1) + " " + punto.y.toFixed(1);
    const previo = points[index - 1];
    if (!previo) return acumulado;
    const medio = (previo.x + punto.x) / 2;
    return (
      acumulado +
      " C" +
      medio.toFixed(1) +
      " " +
      previo.y.toFixed(1) +
      " " +
      medio.toFixed(1) +
      " " +
      punto.y.toFixed(1) +
      " " +
      punto.x.toFixed(1) +
      " " +
      punto.y.toFixed(1)
    );
  }, "");

  const area =
    path +
    " L" +
    (points.at(-1)?.x ?? 0).toFixed(1) +
    " " +
    height +
    " L" +
    margen +
    " " +
    height +
    " Z";

  const formatValue = (value: number): string =>
    format === "money"
      ? formatMoneyCompact(value)
      : format === "minutes"
        ? formatMinutes(value)
        : value.toLocaleString("es-AR");

  return (
    <figure className="w-full">
      <div className="scroll-x">
        <svg
          viewBox={"0 0 " + width + " " + height}
          height={height}
          className="w-full"
          style={{ minWidth: width }}
          role="img"
          aria-label={"Evolución de " + data.length + " períodos"}
        >
          <defs>
            <linearGradient id="fade-imperial" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-imperial-500)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--color-imperial-500)" stopOpacity="0" />
            </linearGradient>
            {/* El resplandor del trazo: es lo que lo despega del fondo negro. */}
            <filter id="brillo-linea" x="-20%" y="-40%" width="140%" height="180%">
              <feGaussianBlur stdDeviation="3" result="borroso" />
              <feMerge>
                <feMergeNode in="borroso" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              x1="0"
              x2={width}
              y1={height - ratio * height}
              y2={height - ratio * height}
              stroke={AXIS}
              strokeWidth="1"
            />
          ))}

          <path d={area} fill="url(#fade-imperial)" className="anim-fade" />
          <path
            d={path}
            fill="none"
            stroke="var(--color-imperial-500)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#brillo-linea)"
            className="chart-line"
            style={{ "--dash": width * 2 } as React.CSSProperties}
          />

          {points.map((point, index) => (
            <g key={index} className="chart-punto">
              <circle
                cx={point.x}
                cy={point.y}
                r="3"
                fill="var(--color-ink-950)"
                stroke="var(--color-imperial-500)"
                strokeWidth="2"
                className="anim-fade"
                style={{ animationDelay: 700 + index * 40 + "ms" }}
              />
              <circle cx={point.x} cy={point.y} r="10" fill="transparent">
                <title>
                  {(data[index]?.label ?? "") + ": " + formatValue(data[index]?.value ?? 0)}
                </title>
              </circle>
            </g>
          ))}
        </svg>
      </div>

      <div className="text-chalk-600 mt-2 flex justify-between text-[0.625rem]">
        <span>{data[0]?.label}</span>
        <span className="tnum text-chalk-300 font-semibold">
          {formatValue(data.at(-1)?.value ?? 0)}
        </span>
        <span>{data.at(-1)?.label}</span>
      </div>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Distribución horizontal                                                    */
/* -------------------------------------------------------------------------- */

export function DistributionBars({
  data,
  format = "minutes",
}: {
  readonly data: readonly { label: string; value: number; sublabel?: string; tone?: string }[];
  readonly format?: "money" | "minutes" | "number";
}) {
  if (data.length === 0) {
    return <p className="text-chalk-600 py-8 text-center text-xs">Sin datos.</p>;
  }

  const max = Math.max(...data.map((item) => item.value), 1);
  const formatValue = (value: number): string =>
    format === "money"
      ? formatMoneyCompact(value)
      : format === "minutes"
        ? formatMinutes(value)
        : value.toLocaleString("es-AR");

  return (
    <ul className="stagger flex flex-col gap-2.5">
      {data.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="text-chalk-200 truncate font-medium">
              {item.label}
              {item.sublabel ? (
                <span className="text-chalk-600 ml-1.5">{item.sublabel}</span>
              ) : null}
            </span>
            <span className="tnum text-chalk-300 shrink-0 font-semibold">
              {formatValue(item.value)}
            </span>
          </div>
          <div className="pista h-1.5 overflow-hidden rounded-full">
            <div
              className={cn(
                "bar-grow barra-viva h-full rounded-full",
                item.tone ?? "bg-imperial-500",
              )}
              style={{ width: Math.max(2, (item.value / max) * 100) + "%" }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Progreso                                                                   */
/* -------------------------------------------------------------------------- */

export function ProgressMeter({
  value,
  total,
  label,
  tone = "bg-jade-500",
}: {
  readonly value: number;
  readonly total: number;
  readonly label: string;
  readonly tone?: string;
}) {
  const percentage = total <= 0 ? 0 : Math.min(100, Math.round((value / total) * 100));

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-xs">
        <span className="text-chalk-400">{label}</span>
        <span className="tnum text-chalk-200 font-semibold">{percentage}%</span>
      </div>
      <div
        className="pista h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn(
            "barra-viva h-full rounded-full transition-[width] duration-700 ease-out",
            tone,
          )}
          style={{ width: percentage + "%" }}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

export interface RankingRow {
  readonly label: string;
  readonly sublabel?: string;
  readonly value: number;
}

/**
 * Una tabla de posiciones, no una lista de barras.
 *
 * "Quién hizo más horas" es una competencia, y una lista de barras grises no lo
 * cuenta: hay que leer los números para saber quién va primero. Acá el puesto
 * es lo primero que se ve, los tres de arriba tienen su color —oro, plata,
 * bronce— y la barra pasa a ser el fondo de la fila en vez de una línea aparte.
 *
 * La barra es relativa al primero y no al total: lo que importa es la distancia
 * al que va ganando, no qué porcentaje del equipo representa cada uno.
 */
export function RankingList({
  data,
  format = "minutes",
  emptyLabel = "Sin datos para este período.",
}: {
  readonly data: readonly RankingRow[];
  readonly format?: "money" | "minutes" | "number";
  readonly emptyLabel?: string;
}) {
  if (data.length === 0) {
    return <p className="text-chalk-600 py-8 text-center text-xs">{emptyLabel}</p>;
  }

  const max = Math.max(...data.map((item) => item.value), 1);
  const formatValue = (value: number): string =>
    format === "money"
      ? formatMoneyCompact(value)
      : format === "minutes"
        ? formatMinutes(value)
        : value.toLocaleString("es-AR");

  return (
    <ol className="stagger flex flex-col gap-1">
      {data.map((item, index) => {
        const puesto = index + 1;
        const porcentaje = Math.max(3, (item.value / max) * 100);

        return (
          <li
            key={item.label + index}
            className={cn("puesto", puesto <= 3 && "puesto-" + puesto)}
            style={{ "--avance": porcentaje + "%" } as React.CSSProperties}
          >
            <span className="puesto-numero">{puesto}</span>

            <span className="min-w-0 flex-1">
              <span className="text-chalk-100 block truncate text-xs font-semibold">
                {item.label}
              </span>
              {item.sublabel ? (
                <span className="text-chalk-600 block truncate text-[0.625rem]">
                  {item.sublabel}
                </span>
              ) : null}
            </span>

            <span className="tnum text-chalk-200 shrink-0 text-xs font-bold">
              {formatValue(item.value)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
