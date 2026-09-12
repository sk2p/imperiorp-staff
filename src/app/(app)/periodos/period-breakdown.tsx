import { cn } from "@/components/ui/primitives";
import type { StaffGroup } from "@/domain/groups";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { rankLabel } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import type { WeekBreakdown } from "@/server/weeks";

/**
 * Lo que hay adentro de un período.
 *
 * La tabla decía "513h" y se terminaba ahí. Ese número no responde ninguna de
 * las preguntas que uno se hace mirándolo: ¿de quiénes son esas horas?, ¿está
 * cargando todo el mundo o son cuatro?, ¿el peso está en High o en Low?
 *
 * Todo lo de acá es HTML y CSS, sin una línea de JavaScript en el navegador:
 * se pinta en el servidor con datos que ya vinieron en la misma consulta.
 */

/** Cada grupo tiene su color, el mismo que usa la planilla de horas. */
const COLOR: Readonly<Record<StaffGroup, string>> = {
  HIGH_STAFF: "var(--color-imperial-500)",
  MID_STAFF: "var(--color-jade-500)",
  LOW_STAFF: "var(--color-sky-400)",
};

const TEXTO: Readonly<Record<StaffGroup, string>> = {
  HIGH_STAFF: "text-imperial-400",
  MID_STAFF: "text-jade-400",
  LOW_STAFF: "text-sky-400",
};

/**
 * Barra de reparto por categoría.
 *
 * Un segmento por grupo, ancho proporcional a sus horas. Se lee de un vistazo
 * sin números: si el tramo violeta se come la barra, las horas son de High.
 */
export function GroupBar({
  breakdown,
  className,
}: {
  readonly breakdown: WeekBreakdown;
  readonly className?: string;
}) {
  if (breakdown.totalMinutes <= 0) return null;

  return (
    <div
      className={cn("reparto", className)}
      role="img"
      aria-label={breakdown.groups
        .map((grupo) => grupo.label + ": " + formatMinutes(grupo.minutes))
        .join(" · ")}
    >
      {breakdown.groups.map((grupo) => (
        <span
          key={grupo.group}
          className="reparto-seg"
          title={
            grupo.label +
            " · " +
            formatMinutes(grupo.minutes) +
            " · " +
            grupo.members +
            (grupo.members === 1 ? " persona" : " personas")
          }
          style={{
            // Sin unidad mínima un grupo con pocas horas desaparece del todo.
            flexGrow: Math.max(grupo.minutes, 1),
            background: COLOR[grupo.group],
          }}
        />
      ))}
    </div>
  );
}

/**
 * El detalle completo, para la tarjeta del período activo: cuánto puso cada
 * categoría en horas y en plata, y quiénes encabezan.
 */
export function PeriodInside({
  breakdown,
  memberCount,
}: {
  readonly breakdown: WeekBreakdown | undefined;
  readonly memberCount: number;
}) {
  if (!breakdown || breakdown.totalMinutes <= 0) {
    return (
      <div className="border-t border-white/[0.07] px-4 py-3.5">
        <p className="mb-0 overline">Qué hay adentro</p>
        <p className="text-chalk-500 mt-1.5 text-xs">
          Todavía no hay ni una hora cargada en este período. Los {memberCount} miembros ya están
          sembrados y esperando.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-white/[0.07] px-4 py-3.5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="mb-0 overline">Qué hay adentro</p>
        <p className="text-chalk-500 text-[0.6875rem]">
          <span className="text-chalk-200 font-semibold">{breakdown.membersWithHours}</span> de{" "}
          {memberCount} cargaron horas
        </p>
      </div>

      <GroupBar breakdown={breakdown} className="reparto-alta" />

      <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
        {breakdown.groups.map((grupo) => (
          <div
            key={grupo.group}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <span className="reparto-punto" style={{ background: COLOR[grupo.group] }} />
              <span className={cn("text-[0.6875rem] font-semibold", TEXTO[grupo.group])}>
                {grupo.label}
              </span>
            </div>
            <p className="tnum text-chalk-50 mt-1 text-sm font-bold">
              {formatMinutes(grupo.minutes)}
            </p>
            <p className="tnum text-chalk-600 text-[0.625rem]" title={formatMoney(grupo.amount)}>
              {formatMoneyCompact(grupo.amount)} · {grupo.members}{" "}
              {grupo.members === 1 ? "persona" : "personas"}
            </p>
          </div>
        ))}
      </div>

      {breakdown.top.length > 0 ? <Podio top={breakdown.top} /> : null}
    </div>
  );
}

/**
 * El podio de las tres personas con más horas del período.
 *
 * Son tres bloques parados en el espacio, con su cara superior a la vista: el
 * primero más alto, los otros dos a los costados, como en un podio de verdad.
 * No es una lista con números al lado — un podio se entiende sin leerlo, y ver
 * el propio nombre arriba de todo es la única parte de este panel que a alguien
 * le da ganas de cargar una hora más.
 *
 * La geometría es CSS: cada bloque gira sobre su eje horizontal y la tapa es
 * una cara acostada noventa grados desde el borde de arriba. Sin imágenes y
 * sin una línea de JavaScript.
 */
const ALTURA = ["3.9rem", "2.7rem", "2rem"] as const;

function Podio({
  top,
}: {
  readonly top: readonly {
    readonly name: string;
    readonly rank: string;
    readonly minutes: number;
  }[];
}) {
  /** Orden en pantalla: segundo, primero, tercero. Como se paran de verdad. */
  const orden = [1, 0, 2].filter((indice) => indice < top.length);

  return (
    <div className="mt-4">
      <p className="mb-0 overline">Más horas</p>

      <div className="podio">
        {orden.map((indice) => {
          const persona = top[indice];
          if (!persona) return null;

          return (
            <div
              key={persona.name + indice}
              className={cn("podio-puesto", "podio-" + (indice + 1))}
            >
              <p className="text-chalk-100 max-w-[7.5rem] truncate text-xs font-semibold">
                {persona.name}
              </p>
              <p className="tnum text-chalk-500 text-[0.625rem]">
                {formatMinutes(persona.minutes)}
              </p>
              <p className="text-chalk-700 mb-1 text-[0.5625rem] tracking-wide uppercase">
                {rankLabel(persona.rank)}
              </p>

              <div className="podio-bloque" style={{ height: ALTURA[indice] }}>
                <span aria-hidden className="podio-tapa" />
                <span className="podio-numero">{indice + 1}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
