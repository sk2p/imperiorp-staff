"use client";

import { useCallback, useState, useTransition } from "react";

import { useCsrfToken, useToast } from "@/components/ui/interactive";
import { cn } from "@/components/ui/primitives";
import { CSRF_FIELD } from "@/lib/auth/csrf";
import { GROUP_DEFINITIONS, readableTextOn } from "@/domain/groups";
import { formatMinutes, formatMinutesClock, parseDurationInput } from "@/domain/time";
import type { WeekGrid } from "@/server/grid";
import { setIcMinutesAction } from "@/server/actions";

/**
 * Horas de personaje del período.
 *
 * Es un control, no una liquidación: sirve para ver quién, además de moderar,
 * está jugando en el servidor. **No se paga** —por eso no hay tarifa, ni
 * importe, ni estados por día— y por eso también es un solo número por persona
 * en toda la semana, en vez de una casilla por día como la planilla de arriba.
 *
 * Va de Mid Staff para arriba: al soporte no se le exige.
 */

interface Props {
  readonly grid: WeekGrid;
  readonly editable: boolean;
}

type ActionResult = { status: string; message?: string };

function IcCell({
  weekId,
  staffMemberId,
  minutes,
  editable,
  onSaved,
}: {
  readonly weekId: string;
  readonly staffMemberId: string;
  readonly minutes: number;
  readonly editable: boolean;
  readonly onSaved: (
    action: (previous: never, data: FormData) => Promise<ActionResult>,
    fields: Record<string, string>,
  ) => void;
}) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(formatMinutesClock(minutes));

  const guardar = () => {
    setEditando(false);
    const parsed = parseDurationInput(valor);

    if (parsed === null) {
      setValor(formatMinutesClock(minutes));
      return;
    }
    if (parsed === minutes) return;

    onSaved(setIcMinutesAction, {
      weekId,
      staffMemberId,
      minutes: String(parsed),
    });
  };

  if (!editable) {
    return (
      <span className={cn("tnum", minutes === 0 && "text-chalk-700")}>
        {formatMinutes(minutes)}
      </span>
    );
  }

  if (editando) {
    return (
      <input
        autoFocus
        value={valor}
        onChange={(event) => setValor(event.target.value)}
        onBlur={guardar}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setValor(formatMinutesClock(minutes));
            setEditando(false);
          }
        }}
        inputMode="numeric"
        placeholder="0:00"
        aria-label="Horas IC"
        className="cell tnum w-20 text-center"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setValor(formatMinutesClock(minutes));
        setEditando(true);
      }}
      className={cn(
        "cell tnum w-20 text-center",
        minutes === 0 ? "text-chalk-700" : "text-chalk-100",
      )}
      title="Click para cargar las horas IC del período"
    >
      {formatMinutesClock(minutes)}
    </button>
  );
}

export function IcHoursPanel({ grid, editable }: Props) {
  const token = useCsrfToken();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const run = useCallback(
    (
      action: (previous: never, data: FormData) => Promise<ActionResult>,
      fields: Record<string, string>,
    ) => {
      const data = new FormData();
      data.set(CSRF_FIELD, token);
      for (const [key, value] of Object.entries(fields)) data.set(key, value);

      startTransition(async () => {
        const result = await action(undefined as never, data);
        if (result.status === "error") toast("error", result.message ?? "No se pudo guardar.");
        else toast("success", "Horas IC guardadas.");
      });
    },
    [token, toast],
  );

  // Sólo Mid y High. El orden es el mismo que el de la planilla de arriba.
  const grupos = grid.groups.filter((g) => g.group !== "LOW_STAFF");
  if (grupos.length === 0) return null;

  const total = grupos.reduce(
    (suma, grupo) => suma + grupo.rows.reduce((s, row) => s + row.icMinutes, 0),
    0,
  );
  const conHoras = grupos.reduce(
    (suma, grupo) => suma + grupo.rows.filter((row) => row.icMinutes > 0).length,
    0,
  );
  const totalPersonas = grupos.reduce((suma, grupo) => suma + grupo.rows.length, 0);

  return (
    <div className="relative">
      {pending ? (
        <div className="anim-fade bg-ink-900/90 text-chalk-400 absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[0.6875rem] backdrop-blur">
          <span className="border-imperial-500 h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent" />
          Guardando…
        </div>
      ) : null}

      <div className="scroll-x">
        <table className="data-table min-w-[28rem]">
          <thead>
            <tr>
              <th className="min-w-[13rem]">Usuario</th>
              <th>Rango</th>
              <th className="text-center">Horas IC del período</th>
            </tr>
          </thead>

          {grupos.map((group) => {
            const definition = GROUP_DEFINITIONS[group.group];
            const suma = group.rows.reduce((s, row) => s + row.icMinutes, 0);

            return (
              <tbody key={group.group}>
                <tr>
                  <td colSpan={3} className="bg-white/[0.025] px-3.5 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className={cn("h-2 w-2 rounded-full", definition.dot)} />
                        <span
                          className={cn(
                            "text-[0.6875rem] font-bold tracking-[0.12em] uppercase",
                            definition.accent,
                          )}
                        >
                          {definition.label}
                        </span>
                      </span>
                      <span className="tnum text-chalk-500 text-[0.6875rem]">
                        {formatMinutes(suma)}
                      </span>
                    </div>
                  </td>
                </tr>

                {group.rows.map((row) => (
                  <tr key={row.staffMemberId}>
                    <td className="text-chalk-100 font-medium">{row.name}</td>
                    <td>
                      <span
                        className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[0.6875rem] font-bold"
                        style={{
                          backgroundColor: row.rankColor,
                          color: readableTextOn(row.rankColor),
                        }}
                      >
                        {row.rank}
                      </span>
                    </td>
                    <td className="text-center">
                      <IcCell
                        weekId={grid.weekId}
                        staffMemberId={row.staffMemberId}
                        minutes={row.icMinutes}
                        editable={editable}
                        onSaved={run}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}

          <tfoot>
            <tr>
              <td colSpan={2} className="text-chalk-400 text-xs font-semibold">
                {conHoras} de {totalPersonas} con horas cargadas
              </td>
              <td className="tnum text-center font-bold">{formatMinutes(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
