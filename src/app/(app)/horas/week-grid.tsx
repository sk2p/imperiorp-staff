"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type DragEvent } from "react";

import { Icon } from "@/components/layout/icons";
import { useCsrfToken, useToast } from "@/components/ui/interactive";
import { cn } from "@/components/ui/primitives";
import { CSRF_FIELD } from "@/lib/auth/csrf";
import {
  DAY_STATUS_DEFINITIONS,
  DAY_STATUS_LIST,
  GROUP_DEFINITIONS,
  readableTextOn,
  statusCounts,
  type DayStatus,
} from "@/domain/groups";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { RANK_LIST } from "@/domain/ranks";
import { formatMinutesClock, parseDurationInput } from "@/domain/time";
import type { WeekGrid } from "@/server/grid";
import {
  changeRankInlineAction,
  removeFromGridAction,
  reorderAction,
  setCellAction,
  setDayStatusAction,
} from "@/server/actions";

/**
 * Planilla semanal.
 *
 * Se escribe directamente sobre la casilla, como en una hoja de cálculo, porque
 * es así como el equipo lleva las horas. Cada cambio se guarda solo: no hay un
 * botón "Guardar todo" que se pueda olvidar de tocar.
 *
 * Click izquierdo en una casilla carga horas. Click derecho sobre la casilla
 * marca el estado de ESE día. Click derecho sobre la etiqueta de rango lo cambia.
 */

interface Props {
  readonly grid: WeekGrid;
  readonly dayLabels: readonly { readonly weekday: string; readonly date: string }[];
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canReorder: boolean;
  readonly canChangeRank: boolean;
}

type ActionResult = { status: string; message?: string };

type Menu =
  | {
      kind: "dia";
      staffMemberId: string;
      name: string;
      workDate: string;
      label: string;
      status: DayStatus;
      x: number;
      y: number;
    }
  | { kind: "rango"; staffMemberId: string; name: string; rank: string; x: number; y: number };

export function WeekGridTable({
  grid,
  dayLabels,
  canEdit,
  canDelete,
  canReorder,
  canChangeRank,
}: Props) {
  const token = useCsrfToken();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [menu, setMenu] = useState<Menu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Dónde caería la fila arrastrada: antes o después de esta otra. */
  const [dropAt, setDropAt] = useState<{ id: string; below: boolean } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const run = useCallback(
    (
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
    },
    [token, toast],
  );

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  /**
   * Marca la ranura donde caería la fila: arriba o abajo de aquella sobre la
   * que está el cursor, según de qué mitad se trate. Sin esta señal el gesto
   * es a ciegas y hay que soltar para ver dónde quedó.
   */
  const handleDragOver = (event: DragEvent<HTMLTableRowElement>, targetId: string) => {
    event.preventDefault();
    if (!dragging || dragging === targetId) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const below = event.clientY > rect.top + rect.height / 2;

    setDropAt((current) =>
      current && current.id === targetId && current.below === below
        ? current
        : { id: targetId, below },
    );
  };

  const handleDrop = (groupIndex: number, targetId: string, below: boolean) => {
    const group = grid.groups[groupIndex];
    if (!dragging || !group || dragging === targetId) return endDrag();

    const ids = group.rows.map((row) => row.staffMemberId);
    // Sólo se reordena dentro del mismo grupo: el grupo lo decide el rango.
    if (!ids.includes(dragging)) return endDrag();

    const rest = ids.filter((id) => id !== dragging);
    const target = rest.indexOf(targetId);
    if (target < 0) return endDrag();

    rest.splice(below ? target + 1 : target, 0, dragging);
    endDrag();

    if (rest.every((id, index) => id === ids[index])) return;
    run(reorderAction, { staffMemberIds: rest }, "Orden actualizado.");
  };

  const columns = 4 + dayLabels.length + (canDelete ? 1 : 0);

  return (
    <div className="relative">
      {pending ? (
        <div className="anim-fade bg-ink-900/90 text-chalk-400 absolute top-2 right-3 z-10 flex items-center gap-1.5 rounded-full border border-white/12 px-2.5 py-1 text-[0.6875rem] backdrop-blur">
          <span className="border-imperial-500 h-2.5 w-2.5 animate-spin rounded-full border-2 border-t-transparent" />
          Guardando…
        </div>
      ) : null}

      <div className="scroll-x">
        <table className="data-table min-w-[66rem]">
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
                  const sameGroup =
                    dragging !== null &&
                    group.rows.some((other) => other.staffMemberId === dragging);
                  const marker = sameGroup && dropAt?.id === row.staffMemberId ? dropAt : null;

                  return (
                    <tr
                      key={row.staffMemberId}
                      draggable={canReorder}
                      onDragStart={() => setDragging(row.staffMemberId)}
                      onDragEnd={endDrag}
                      onDragOver={(event) => handleDragOver(event, row.staffMemberId)}
                      onDrop={() =>
                        handleDrop(groupIndex, row.staffMemberId, marker?.below ?? false)
                      }
                      className={cn(
                        dragging === row.staffMemberId && "row-dragging",
                        marker && (marker.below ? "drop-below" : "drop-above"),
                      )}
                    >
                      <td>
                        <div className="flex items-center gap-2">
                          {canReorder ? (
                            <span
                              className="text-chalk-700 cursor-grab active:cursor-grabbing"
                              title="Arrastrá para reordenar"
                            >
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
                              Staff registrado
                            </span>
                          </span>
                        </div>
                      </td>

                      <td>
                        <button
                          type="button"
                          disabled={!canChangeRank}
                          title={canChangeRank ? "Click derecho para cambiar el rango" : undefined}
                          onContextMenu={(event) => {
                            if (!canChangeRank) return;
                            event.preventDefault();
                            setMenu({
                              kind: "rango",
                              staffMemberId: row.staffMemberId,
                              name: row.name,
                              rank: row.rank,
                              x: event.clientX,
                              y: event.clientY,
                            });
                          }}
                          style={{
                            backgroundColor: row.rankColor,
                            color: readableTextOn(row.rankColor),
                          }}
                          className={cn(
                            "inline-flex rounded-md px-2 py-0.5 text-[0.625rem] font-bold transition",
                            canChangeRank
                              ? "cursor-context-menu hover:brightness-110"
                              : "cursor-default",
                          )}
                        >
                          {row.rank}
                        </button>
                      </td>

                      {row.days.map((cell, dayIndex) => (
                        <HourCell
                          key={cell.workDate}
                          minutes={cell.minutes}
                          status={cell.status}
                          editable={canEdit}
                          title={
                            cell.recordedByUsername
                              ? "Cargado por " + cell.recordedByUsername
                              : undefined
                          }
                          onSave={(minutes) =>
                            run(setCellAction, {
                              weekId: grid.weekId,
                              staffMemberId: row.staffMemberId,
                              workDate: cell.workDate,
                              minutes: String(minutes),
                            })
                          }
                          onContextMenu={(x, y) =>
                            setMenu({
                              kind: "dia",
                              staffMemberId: row.staffMemberId,
                              name: row.name,
                              workDate: cell.workDate,
                              label:
                                (dayLabels[dayIndex]?.weekday ?? "") +
                                " " +
                                (dayLabels[dayIndex]?.date ?? ""),
                              status: cell.status,
                              x,
                              y,
                            })
                          }
                        />
                      ))}

                      <td className="tnum text-chalk-100 text-right font-semibold">
                        {formatMinutesClock(row.totalMinutes)}
                      </td>

                      <td className="tnum text-jade-400 text-right font-semibold">
                        {formatMoney(row.amount)}
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
                            className="cell border-imperial-500/30 text-imperial-400 hover:bg-imperial-500/15 inline-flex h-7 w-7 items-center justify-center rounded-md border"
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

      {menu ? (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          style={{
            left: Math.min(menu.x, (globalThis.innerWidth ?? 1200) - 260),
            top: Math.min(menu.y, (globalThis.innerHeight ?? 800) - 330),
          }}
          className="anim-menu bg-ink-900 fixed z-50 w-60 overflow-hidden rounded-xl border border-white/12 shadow-[0_16px_50px_-12px_rgb(0_0_0/0.9)]"
        >
          {menu.kind === "dia" ? (
            <>
              <div className="border-b border-white/[0.07] px-3 py-2">
                <p className="text-chalk-400 text-[0.6875rem] font-bold tracking-wider uppercase">
                  Estado del día
                </p>
                <p className="text-chalk-600 truncate text-xs">
                  {menu.name} · {menu.label}
                </p>
              </div>
              {DAY_STATUS_LIST.map((option) => (
                <button
                  key={option.status}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const target = menu;
                    setMenu(null);
                    run(
                      setDayStatusAction,
                      {
                        weekId: grid.weekId,
                        staffMemberId: target.staffMemberId,
                        workDate: target.workDate,
                        status: option.status,
                      },
                      option.short,
                    );
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-white/[0.06]",
                    menu.status === option.status && "bg-white/[0.04]",
                  )}
                >
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", option.dot)} />
                  <span className="min-w-0 flex-1">
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
            </>
          ) : (
            <>
              <div className="border-b border-white/[0.07] px-3 py-2">
                <p className="text-chalk-400 text-[0.6875rem] font-bold tracking-wider uppercase">
                  Cambiar rango
                </p>
                <p className="text-chalk-600 truncate text-xs">{menu.name}</p>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {[...RANK_LIST].reverse().map((rank) => (
                  <button
                    key={rank.rank}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const target = menu;
                      setMenu(null);
                      run(
                        changeRankInlineAction,
                        {
                          weekId: grid.weekId,
                          staffMemberId: target.staffMemberId,
                          rank: rank.rank,
                        },
                        "Rango: " + rank.rank,
                      );
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition hover:bg-white/[0.06]",
                      menu.rank === rank.rank && "bg-white/[0.04]",
                    )}
                  >
                    <span className="text-chalk-100 w-14 shrink-0 text-xs font-bold">
                      {rank.rank}
                    </span>
                    <span className="text-chalk-600 min-w-0 flex-1 truncate text-[0.625rem]">
                      {rank.name}
                    </span>
                    {menu.rank === rank.rank ? (
                      <Icon name="check" size={13} className="text-jade-400 shrink-0" />
                    ) : null}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}

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
              se conservan, y podés reincorporarlo cuando quieras desde <strong>Staff</strong>.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="btn btn-quiet text-chalk-400 h-9 rounded-[11px] px-4 text-sm font-semibold hover:bg-white/[0.06]"
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
                className="btn btn-quiet border-imperial-500/35 text-imperial-400 hover:bg-imperial-500/12 h-9 rounded-[11px] border px-4 text-sm font-semibold"
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
 * Casilla de un día.
 *
 * Acepta lo que la gente escribe de verdad: `2:30`, `2h 30m`, `2.5`, `150m` o un
 * número suelto de horas. Enter o salir del campo confirma; Escape descarta.
 * El color marca el estado de ESE día: la fila entera no se tiñe.
 */
function HourCell({
  minutes,
  status,
  editable,
  title,
  onSave,
  onContextMenu,
}: {
  readonly minutes: number;
  readonly status: DayStatus;
  readonly editable: boolean;
  readonly title?: string | undefined;
  readonly onSave: (minutes: number) => void;
  readonly onContextMenu: (x: number, y: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    // Se lee del campo y no del estado: si se escribe y se confirma en el mismo
    // ciclo, el estado de React puede venir atrasado.
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

  const definition = DAY_STATUS_DEFINITIONS[status];
  const cuenta = statusCounts(status);

  return (
    <td className="p-1 text-center">
      <button
        type="button"
        disabled={!editable}
        title={cuenta ? title : definition.short}
        onClick={() => {
          if (!editable) return;
          setDraft(minutes > 0 ? formatMinutesClock(minutes) : "");
          setEditing(true);
        }}
        onContextMenu={(event) => {
          if (!editable) return;
          event.preventDefault();
          onContextMenu(event.clientX, event.clientY);
        }}
        className={cn(
          "cell tnum h-8 w-[4.5rem] rounded-lg border text-xs font-semibold",
          cuenta
            ? minutes > 0
              ? "text-chalk-100 border-white/12 bg-white/[0.05]"
              : "text-chalk-600 border-white/[0.06]"
            : definition.cellTint,
          editable ? "hover:border-imperial-500/50" : "cursor-default",
        )}
      >
        {cuenta ? formatMinutesClock(minutes) : definition.short.slice(0, 4)}
      </button>
    </td>
  );
}
