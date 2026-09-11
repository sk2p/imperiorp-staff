"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { Icon } from "@/components/layout/icons";
import { useCsrfToken, useToast } from "@/components/ui/interactive";
import { cn } from "@/components/ui/primitives";
import { CSRF_FIELD } from "@/lib/auth/csrf";
import {
  GROUP_DEFINITIONS,
  WEEKLY_STATUS_DEFINITIONS,
  WEEKLY_STATUS_LIST,
  statusCounts,
  type WeeklyStatus,
} from "@/domain/groups";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { formatMinutesClock, parseDurationInput } from "@/domain/time";
import type { WeekGrid } from "@/server/grid";
import {
  removeFromGridAction,
  reorderAction,
  setCellAction,
  setStatusAction,
} from "@/server/actions";

/**
 * Planilla semanal de horas.
 *
 * Una fila por persona, una casilla por día. Se escribe directamente sobre la
 * casilla, como en una planilla de cálculo, porque es así como el equipo lleva
 * las horas y cualquier paso intermedio se vuelve fricción cuando hay cuarenta
 * personas que cargar.
 *
 * Cada casilla guarda por su cuenta apenas se confirma. No hay un botón
 * "Guardar todo" que se pueda olvidar de tocar.
 */

interface Props {
  readonly grid: WeekGrid;
  readonly dayLabels: readonly { readonly weekday: string; readonly date: string }[];
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canReorder: boolean;
}

type ActionResult = { status: string; message?: string };

export function WeekGridTable({ grid, dayLabels, canEdit, canDelete, canReorder }: Props) {
  const token = useCsrfToken();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [menu, setMenu] = useState<{
    staffMemberId: string;
    name: string;
    status: WeeklyStatus;
    x: number;
    y: number;
  } | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // El menú contextual se cierra al hacer clic en cualquier lado o con Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const run = (
    action: (previous: never, data: FormData) => Promise<ActionResult>,
    fields: Record<string, string | readonly string[]>,
    successMessage?: string,
  ) => {
    const data = new FormData();
    data.set(CSRF_FIELD, token);
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) for (const item of value) data.append(key + "[]", item);
      else data.set(key, value as string);
    }

    startTransition(async () => {
      const result = await action(undefined as never, data);
      if (result.status === "error") toast("error", result.message ?? "No se pudo guardar.");
      else if (successMessage) toast("success", successMessage);
    });
  };

  const saveCell = (staffMemberId: string, workDate: string, minutes: number) =>
    run(setCellAction, {
      weekId: grid.weekId,
      staffMemberId,
      workDate,
      minutes: String(minutes),
    });

  const changeStatus = (staffMemberId: string, status: WeeklyStatus) => {
    setMenu(null);
    run(
      setStatusAction,
      { weekId: grid.weekId, staffMemberId, status },
      "Estado: " + WEEKLY_STATUS_DEFINITIONS[status].short,
    );
  };

  const handleDrop = (groupIndex: number, targetId: string) => {
    const group = grid.groups[groupIndex];
    if (!dragging || !group || dragging === targetId) return setDragging(null);

    const ids = group.rows.map((row) => row.staffMemberId);
    const from = ids.indexOf(dragging);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return setDragging(null);

    ids.splice(to, 0, ...ids.splice(from, 1));
    setDragging(null);
    run(reorderAction, { staffMemberIds: ids }, "Orden actualizado.");
  };

  return (
    <div className="relative">
      {pending ? (
        <div className="anim-fade bg-ink-900/90 text-chalk-400 absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[0.6875rem] backdrop-blur">
          <span className="border-imperial-500 h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent" />
          Guardando…
        </div>
      ) : null}

      <div className="scroll-x">
        <table className="data-table min-w-[64rem]">
          <thead>
            <tr>
              <th className="min-w-[13rem]">Usuario</th>
              <th>Rango</th>
              {dayLabels.map((day) => (
                <th key={day.date} className="text-center">
                  <span className="block">{day.weekday}</span>
                  <span className="text-chalk-600 block font-normal">{day.date}</span>
                </th>
              ))}
              <th className="text-right">Total</th>
              <th className="text-right">Paga semanal</th>
              {canDelete ? <th className="text-center">Quitar</th> : null}
            </tr>
          </thead>

          {grid.groups.map((group, groupIndex) => {
            const definition = GROUP_DEFINITIONS[group.group];
            const columns = 4 + dayLabels.length + (canDelete ? 1 : 0);

            return (
              <tbody key={group.group}>
                <tr>
                  <td colSpan={columns} className="bg-white/[0.025] px-3.5 py-2">
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
                        {formatMoney(group.hourlyRate)}/hora
                        <span className="text-chalk-700 mx-2">·</span>
                        {group.memberCount} {group.memberCount === 1 ? "usuario" : "usuarios"}
                        <span className="text-chalk-700 mx-2">·</span>
                        <span className="text-chalk-300 font-semibold">
                          {formatMoneyCompact(group.totalAmount)}
                        </span>
                      </span>
                    </div>
                  </td>
                </tr>

                {group.rows.map((row) => {
                  const statusDefinition = WEEKLY_STATUS_DEFINITIONS[row.status];
                  const cuenta = statusCounts(row.status);

                  return (
                    <tr
                      key={row.staffMemberId}
                      draggable={canReorder}
                      onDragStart={() => setDragging(row.staffMemberId)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => handleDrop(groupIndex, row.staffMemberId)}
                      onContextMenu={(event) => {
                        if (!canEdit) return;
                        event.preventDefault();
                        setMenu({
                          staffMemberId: row.staffMemberId,
                          name: row.name,
                          status: row.status,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                      className={cn(
                        statusDefinition.rowTint,
                        dragging === row.staffMemberId && "opacity-40",
                        canReorder && "cursor-grab active:cursor-grabbing",
                      )}
                    >
                      <td>
                        <div className="flex items-center gap-2">
                          {canReorder ? (
                            <span className="text-chalk-700" title="Arrastrá para reordenar">
                              <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden>
                                <g fill="currentColor">
                                  <circle cx="2" cy="2" r="1.2" />
                                  <circle cx="8" cy="2" r="1.2" />
                                  <circle cx="2" cy="7" r="1.2" />
                                  <circle cx="8" cy="7" r="1.2" />
                                  <circle cx="2" cy="12" r="1.2" />
                                  <circle cx="8" cy="12" r="1.2" />
                                </g>
                              </svg>
                            </span>
                          ) : null}
                          <span className="min-w-0">
                            <span className="text-chalk-100 block truncate font-medium">
                              [{row.rank}] {row.name}
                            </span>
                            <span className="text-chalk-600 block text-[0.625rem]">
                              {statusDefinition.counts
                                ? "Staff registrado"
                                : statusDefinition.short + " · no cobra"}
                            </span>
                          </span>
                        </div>
                      </td>

                      <td>
                        <span
                          className={cn(
                            "inline-flex rounded-md border px-2 py-0.5 text-[0.625rem] font-bold",
                            row.status === "normal"
                              ? "text-chalk-200 border-white/12 bg-white/[0.05]"
                              : statusDefinition.badge,
                          )}
                        >
                          {row.rank}
                        </span>
                      </td>

                      {row.days.map((cell) => (
                        <HourCell
                          key={cell.workDate}
                          minutes={cell.minutes}
                          editable={canEdit && grid.editable}
                          dimmed={!cuenta}
                          title={
                            cell.recordedByUsername
                              ? "Cargado por " + cell.recordedByUsername
                              : undefined
                          }
                          onSave={(minutes) => saveCell(row.staffMemberId, cell.workDate, minutes)}
                        />
                      ))}

                      <td className="tnum text-chalk-100 text-right font-semibold">
                        {formatMinutesClock(row.totalMinutes)}
                      </td>

                      <td
                        className={cn(
                          "tnum text-right font-semibold",
                          cuenta ? "text-jade-400" : "text-chalk-600",
                        )}
                      >
                        {formatMoney(cuenta ? row.amount : 0)}
                      </td>

                      {canDelete ? (
                        <td className="text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmDelete({ id: row.staffMemberId, name: row.name })
                            }
                            aria-label={"Quitar a " + row.name}
                            title={"Quitar a " + row.name}
                            className="border-imperial-500/30 text-imperial-400 hover:bg-imperial-500/15 inline-flex h-7 w-7 items-center justify-center rounded-md border transition active:scale-95"
                          >
                            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
                              <path
                                d="M2.5 3.5h9M5.5 3.5V2.2h3v1.3M3.6 3.5l.5 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.5-8"
                                stroke="currentColor"
                                strokeWidth="1.3"
                                strokeLinecap="round"
                              />
                            </svg>
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}

          <tfoot>
            <tr className="border-t border-white/12 bg-white/[0.03]">
              <td colSpan={2} className="text-chalk-300 px-3.5 py-3 text-xs font-semibold">
                Total del período
              </td>
              <td colSpan={dayLabels.length} />
              <td className="tnum text-chalk-50 px-3.5 py-3 text-right text-sm font-bold">
                {formatMinutesClock(grid.totalMinutes)}
              </td>
              <td className="tnum text-imperial-400 px-3.5 py-3 text-right text-sm font-bold">
                {formatMoney(grid.totalAmount)}
              </td>
              {canDelete ? <td /> : null}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Menú de estado (clic derecho sobre la fila) */}
      {menu ? (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          style={{ left: Math.min(menu.x, window.innerWidth - 250), top: menu.y }}
          className="anim-pop bg-ink-900 fixed z-50 w-60 overflow-hidden rounded-xl border border-white/12 shadow-[0_16px_50px_-12px_rgb(0_0_0/0.9)]"
        >
          <div className="border-b border-white/[0.07] px-3 py-2">
            <p className="text-chalk-400 text-[0.6875rem] font-bold tracking-wider uppercase">
              Cambiar estado
            </p>
            <p className="text-chalk-600 truncate text-xs">{menu.name}</p>
          </div>
          {WEEKLY_STATUS_LIST.map((option) => (
            <button
              key={option.status}
              type="button"
              role="menuitem"
              onClick={() => changeStatus(menu.staffMemberId, option.status)}
              className={cn(
                "flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-white/[0.06]",
                menu.status === option.status && "bg-white/[0.04]",
              )}
            >
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", option.dot)} />
              <span className="min-w-0">
                <span className="text-chalk-100 block text-xs font-medium">{option.label}</span>
                <span className="text-chalk-600 block text-[0.625rem] leading-snug">
                  {option.description}
                </span>
              </span>
              {menu.status === option.status ? (
                <Icon name="check" size={13} className="text-jade-400 mt-0.5 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {/* Confirmación de baja */}
      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
          <button
            type="button"
            aria-label="Cancelar"
            onClick={() => setConfirmDelete(null)}
            className="anim-fade absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <div className="anim-pop bg-ink-900 relative w-full max-w-sm rounded-2xl border border-white/12 p-5">
            <h2 className="text-chalk-50 text-sm font-semibold">Quitar a {confirmDelete.name}</h2>
            <p className="text-chalk-400 mt-2 text-xs leading-relaxed">
              No se borra nada: queda archivado y sale de la planilla. Sus horas, pagos e historial
              se conservan y podés reincorporarlo cuando quieras desde <strong>Staff</strong>.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="text-chalk-400 h-9 rounded-[10px] px-4 text-sm font-semibold transition hover:bg-white/[0.05]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  run(
                    removeFromGridAction,
                    { staffMemberId: target.id, reason: "Baja desde la planilla de horas" },
                    target.name + " quedó archivado.",
                  );
                }}
                className="border-imperial-500/35 text-imperial-400 hover:bg-imperial-500/12 h-9 rounded-[10px] border px-4 text-sm font-semibold transition"
              >
                Archivar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Casilla                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Casilla editable.
 *
 * Acepta lo que la gente escribe de verdad: `2:30`, `2h 30m`, `2.5`, `150m` o
 * un número suelto de horas. Enter o salir del campo confirma; Escape descarta.
 */
function HourCell({
  minutes,
  editable,
  dimmed,
  title,
  onSave,
}: {
  readonly minutes: number;
  readonly editable: boolean;
  readonly dimmed: boolean;
  readonly title?: string | undefined;
  readonly onSave: (minutes: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    // Se lee del campo y no del estado: si el guardado se dispara en el mismo
    // ciclo en que se escribió, el estado todavía puede venir atrasado.
    const trimmed = (inputRef.current?.value ?? draft).trim();
    if (trimmed.length === 0) return;

    const parsed = parseDurationInput(trimmed);
    if (parsed === null || parsed === minutes) return;
    onSave(parsed);
  };

  if (editing) {
    return (
      <td className="p-1 text-center">
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(false);
          }}
          inputMode="text"
          aria-label="Horas del día"
          className="field tnum h-8 w-[4.5rem] py-0 text-center text-xs"
        />
      </td>
    );
  }

  return (
    <td className="p-1 text-center">
      <button
        type="button"
        disabled={!editable}
        title={title}
        onClick={() => {
          if (!editable) return;
          setDraft(minutes > 0 ? formatMinutesClock(minutes) : "");
          setEditing(true);
        }}
        className={cn(
          "tnum h-8 w-[4.5rem] rounded-lg border text-xs font-semibold transition",
          minutes > 0
            ? "text-chalk-100 border-white/12 bg-white/[0.05]"
            : "text-chalk-600 border-white/[0.06]",
          dimmed && "opacity-45",
          editable
            ? "hover:border-imperial-500/50 hover:bg-imperial-500/10 active:scale-95"
            : "cursor-default",
        )}
      >
        {formatMinutesClock(minutes)}
      </button>
    </td>
  );
}
