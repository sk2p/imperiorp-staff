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

  const gap = 0.24;
  const slot = 100 / data.length;
  const barWidth = slot * (1 - gap);

  return (
    <figure className="w-full">
      <div className="scroll-x">
        <div style={{ minWidth: Math.max(320, data.length * 46) }}>
          <svg
            viewBox={`0 0 100 ${height}`}
            preserveAspectRatio="none"
            height={height}
            className="w-full"
            role="img"
            aria-label={"Gráfico de barras con " + data.length + " valores"}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
              <line
                key={ratio}
                x1="0"
                x2="100"
                y1={height - ratio * height}
                y2={height - ratio * height}
                stroke={AXIS}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {data.map((item, index) => {
              const x = index * slot + (slot - barWidth) / 2;
              const barHeight = Math.max(1, (item.value / max) * (height - 4));
              const secondaryHeight =
                item.secondary === undefined
                  ? 0
                  : Math.max(0, (item.secondary / max) * (height - 4));

              return (
                <g key={item.label + index}>
                  <rect
                    x={x}
                    y={height - barHeight}
                    width={barWidth}
                    height={barHeight}
                    rx="1"
                    className="chart-bar"
                    style={{ animationDelay: index * 40 + "ms" }}
                    fill={item.highlight ? "var(--color-imperial-500)" : "var(--color-ink-600)"}
                  />
                  {secondaryHeight > 0 ? (
                    <rect
                      x={x}
                      y={height - secondaryHeight}
                      width={barWidth}
                      height={secondaryHeight}
                      rx="1"
                      className="chart-bar"
                      style={{ animationDelay: index * 40 + 120 + "ms" }}
                      fill="var(--color-jade-500)"
                      opacity="0.85"
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>

          <div className="mt-2 flex" style={{ minWidth: Math.max(320, data.length * 46) }}>
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
  const stepX = 100 / (data.length - 1);
  const points = data.map((item, index) => ({
    x: index * stepX,
    y: height - (item.value / max) * (height - 8) - 4,
  }));

  const path = points
    .map(
      (point, index) => (index === 0 ? "M" : "L") + point.x.toFixed(2) + " " + point.y.toFixed(2),
    )
    .join(" ");

  const area =
    path + " L" + (points.at(-1)?.x ?? 0).toFixed(2) + " " + height + " L0 " + height + " Z";

  const formatValue = (value: number): string =>
    format === "money"
      ? formatMoneyCompact(value)
      : format === "minutes"
        ? formatMinutes(value)
        : value.toLocaleString("es-AR");

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        height={height}
        className="w-full"
        role="img"
        aria-label={"Evolución de " + data.length + " períodos"}
      >
        <defs>
          <linearGradient id="fade-imperial" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-imperial-500)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--color-imperial-500)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1="0"
            x2="100"
            y1={height - ratio * height}
            y2={height - ratio * height}
            stroke={AXIS}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
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
          vectorEffect="non-scaling-stroke"
          className="chart-line"
          style={{ "--dash": 400 } as React.CSSProperties}
        />
        {points.map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r="2"
            fill="var(--color-ink-950)"
            stroke="var(--color-imperial-500)"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
            className="anim-fade"
            style={{ animationDelay: 700 + index * 40 + "ms" }}
          />
        ))}
      </svg>

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
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className={cn("bar-grow h-full rounded-full", item.tone ?? "bg-imperial-500")}
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
        className="h-2 overflow-hidden rounded-full bg-white/[0.05]"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-700 ease-out", tone)}
          style={{ width: percentage + "%" }}
        />
      </div>
    </div>
  );
}
