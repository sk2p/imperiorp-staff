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

      {breakdown.top.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-chalk-700 text-[0.625rem] tracking-[0.14em] uppercase">
            Más horas
          </span>
          {breakdown.top.map((persona, indice) => (
            <span key={persona.name + indice} className="reparto-chip">
              <span className="reparto-chip-puesto">{indice + 1}</span>
              <span className="text-chalk-200 font-medium">{persona.name}</span>
              <span className="text-chalk-600">{rankLabel(persona.rank)}</span>
              <span className="tnum text-chalk-300 font-semibold">
                {formatMinutes(persona.minutes)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
