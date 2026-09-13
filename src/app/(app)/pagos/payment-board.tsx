"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";

import { Icon } from "@/components/layout/icons";
import { useCsrfToken, useToast } from "@/components/ui/interactive";
import { cn } from "@/components/ui/primitives";
import { CSRF_FIELD } from "@/lib/auth/csrf";
import { GROUP_DEFINITIONS, readableTextOn } from "@/domain/groups";
import { localDateShort } from "@/domain/clock";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { formatMinutes } from "@/domain/time";
import type { PaymentBoard } from "@/server/payments";
import { togglePaymentAction } from "@/server/actions";

/**
 * Tablero de pagos.
 *
 * Es la pantalla que se mira mientras se reparte la plata: el staff entero,
 * partido en High, Mid y Low, con las horas y el importe de cada uno. Todo lo
 * demás está de más acá.
 *
 * Cada fila es amarilla mientras falta pagar y verde una vez pagada. El estado
 * se cambia con click derecho, sin diálogos ni confirmaciones, porque en una
 * tanda de treinta pagos un formulario por persona no se usa.
 *
 * El color no es una marca suelta: marcar registra el pago de verdad, con su
 * asiento en la auditoría, y desmarcar lo anula. Lo que se ve acá y lo que
 * figura en el historial son siempre lo mismo.
 */

interface Props {
  readonly board: PaymentBoard;
  readonly weekId: string;
  readonly canPay: boolean;
  readonly canVoid: boolean;
  readonly isClosed: boolean;
}

type Menu = {
  readonly x: number;
  readonly y: number;
  readonly staffMemberId: string;
  readonly name: string;
  readonly paid: boolean;
  readonly amount: number;
};

export function PaymentLegend({
  pendingCount,
  paidCount,
}: {
  readonly pendingCount: number;
  readonly paidCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="pay-chip pay-chip-pending">
        <span className="pay-dot pay-dot-pending" />
        Falta pagar
        <span className="tnum opacity-70">{pendingCount}</span>
      </span>
      <span className="pay-chip pay-chip-paid">
        <span className="pay-dot pay-dot-paid" />
        Pagado
        <span className="tnum opacity-70">{paidCount}</span>
      </span>
    </div>
  );
}

export function PaymentBoardTable({ board, weekId, canPay, canVoid, isClosed }: Props) {
  const token = useCsrfToken();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [menu, setMenu] = useState<Menu | null>(null);

  /**
   * Dónde termina dibujándose el menú.
   *
   * Antes salía de `Math.min(clic, alto - 190)`: un intento de que no se saliera
   * por abajo que, con la ventana corta o el clic cerca del pie, plantaba el
   * menú noventa píxeles POR ENCIMA del cursor. Uno hace clic derecho sobre una
   * fila y el menú aparece sobre otra: el error de apuntar a la fila
   * equivocada estaba servido, y acá cada fila es la plata de una persona.
   *
   * Ahora se mide el menú de verdad, después de montarlo y antes de que el
   * navegador lo pinte. Si entra para abajo va abajo del cursor, como cualquier
   * menú contextual; si no entra, se da vuelta y va arriba, anclado igual al
   * punto donde se hizo clic. Nunca queda flotando en el medio.
   */
  const menuRef = useRef<HTMLDivElement>(null);
  const [posicion, setPosicion] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const nodo = menuRef.current;
    if (!menu || !nodo) {
      setPosicion(null);
      return;
    }

    const caja = nodo.getBoundingClientRect();
    const margen = 8;
    const alto = globalThis.innerHeight ?? 800;
    const ancho = globalThis.innerWidth ?? 1200;

    // Abajo del cursor salvo que no entre; ahí se da vuelta hacia arriba.
    const cabeAbajo = menu.y + caja.height + margen <= alto;
    const top = cabeAbajo
      ? menu.y
      : Math.max(margen, Math.min(menu.y - caja.height, alto - caja.height - margen));

    const left = Math.max(margen, Math.min(menu.x, ancho - caja.width - margen));

    setPosicion({ left, top });
  }, [menu]);

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

  const toggle = useCallback(
    (staffMemberId: string, paid: boolean) => {
      const data = new FormData();
      data.set(CSRF_FIELD, token);
      data.set("weekId", weekId);
      data.set("staffMemberId", staffMemberId);
      data.set("paid", paid ? "true" : "");

      startTransition(async () => {
        const result = await togglePaymentAction(undefined as never, data);
        if (result.status === "error") toast("error", result.message);
        else if (result.status === "success") toast("success", result.message);
      });
    },
    [token, weekId, toast],
  );

  const abrirMenu = (x: number, y: number, row: Omit<Menu, "x" | "y">) => {
    if (!canPay) return;
    setMenu({ ...row, x, y });
  };

  return (
    <div className="relative">
      {pending ? (
        <div className="anim-fade guardando">
          <span className="loader-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          Guardando…
        </div>
      ) : null}

      <div className="scroll-x">
        <table className="data-table min-w-[44rem]">
          <thead>
            <tr>
              <th className="min-w-[13rem]">Staff</th>
              <th>Rango</th>
              <th className="text-right">Total de horas</th>
              <th className="text-right">Tiene que cobrar</th>
              <th className="text-center">Estado</th>
            </tr>
          </thead>

          {board.groups.map((group) => {
            const definition = GROUP_DEFINITIONS[group.group];

            return (
              <tbody key={group.group}>
                <tr>
                  <td colSpan={5} className="bg-white/[0.025] px-3.5 py-2">
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
                        {formatMinutes(group.totalMinutes)}
                        <span className="text-chalk-700 mx-2">·</span>
                        <span className="text-chalk-300 font-semibold">
                          {formatMoneyCompact(group.totalAmount)}
                        </span>
                        {group.pendingCount > 0 ? (
                          <>
                            <span className="text-chalk-700 mx-2">·</span>
                            <span className="pay-text-pending font-semibold">
                              falta {formatMoneyCompact(group.pendingAmount)}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="text-chalk-700 mx-2">·</span>
                            <span className="pay-text-paid font-semibold">todo pagado</span>
                          </>
                        )}
                      </span>
                    </div>
                  </td>
                </tr>

                {group.rows.map((row) => (
                  <tr
                    key={row.staffMemberId}
                    onContextMenu={(event) => {
                      if (!canPay) return;
                      event.preventDefault();
                      abrirMenu(event.clientX, event.clientY, {
                        staffMemberId: row.staffMemberId,
                        name: row.name,
                        paid: row.paid,
                        amount: row.amount,
                      });
                    }}
                    className={cn(
                      row.paid ? "pay-row-paid" : "pay-row-pending",
                      canPay && "cursor-context-menu",
                    )}
                    title={canPay ? "Click derecho —o tocá el estado— para cambiarlo" : undefined}
                  >
                    <td className="text-chalk-100 font-medium">
                      {row.name}
                      {row.paid && row.paidByUsername ? (
                        <span className="text-chalk-600 mt-0.5 block text-[0.625rem]">
                          {row.paidByUsername}
                          {row.paidAt ? " · " + localDateShort(row.paidAt) : ""}
                        </span>
                      ) : null}
                    </td>
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
                    <td className="tnum text-right font-semibold">
                      {formatMinutes(row.totalMinutes)}
                    </td>
                    <td className="tnum text-right text-sm font-bold">
                      {formatMoney(row.paid ? (row.paidAmount ?? row.amount) : row.amount)}
                      {row.paid && row.paidAmount !== null && row.paidAmount !== row.amount ? (
                        <span className="mt-0.5 block text-[0.625rem] font-normal text-amber-400">
                          ahora calcula {formatMoneyCompact(row.amount)}
                        </span>
                      ) : null}
                    </td>
                    <td className="text-center">
                      {/*
                        El estado es un BOTÓN, no un cartel.

                        Cambiarlo se hacía sólo con clic derecho, que en un
                        teléfono no existe: desde el celular no había manera de
                        marcar un pago. Y la mitad del staff abre esto desde el
                        teléfono. Tocar el estado abre el mismo menú, anclado al
                        propio botón; el clic derecho sobre la fila sigue
                        andando para quien ya lo tenía en la mano.
                      */}
                      {canPay ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            const caja = event.currentTarget.getBoundingClientRect();
                            abrirMenu(caja.left, caja.bottom + 6, {
                              staffMemberId: row.staffMemberId,
                              name: row.name,
                              paid: row.paid,
                              amount: row.amount,
                            });
                          }}
                          aria-haspopup="menu"
                          aria-label={
                            "Cambiar el estado del pago de " +
                            row.name +
                            " (ahora: " +
                            (row.paid ? "pagado" : "falta pagar") +
                            ")"
                          }
                          className={cn(
                            "pay-chip pay-chip-boton",
                            row.paid ? "pay-chip-paid" : "pay-chip-pending",
                          )}
                        >
                          <span
                            className={cn("pay-dot", row.paid ? "pay-dot-paid" : "pay-dot-pending")}
                          />
                          {row.paid ? "Pagado" : "Falta pagar"}
                        </button>
                      ) : (
                        <span
                          className={cn(
                            "pay-chip",
                            row.paid ? "pay-chip-paid" : "pay-chip-pending",
                          )}
                        >
                          <span
                            className={cn("pay-dot", row.paid ? "pay-dot-paid" : "pay-dot-pending")}
                          />
                          {row.paid ? "Pagado" : "Falta pagar"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}

          <tfoot>
            <tr>
              <td colSpan={2} className="text-chalk-400 text-xs font-semibold">
                {board.memberCount} {board.memberCount === 1 ? "staff" : "staff"} en total
              </td>
              <td className="tnum text-right font-bold">{formatMinutes(board.totalMinutes)}</td>
              <td className="tnum text-right text-sm font-bold">
                {formatMoney(board.totalAmount)}
              </td>
              <td className="text-center">
                <span className="tnum text-[0.6875rem]">
                  <span className="pay-text-paid font-semibold">{board.paidCount}</span>
                  <span className="text-chalk-700 mx-1">/</span>
                  <span className="pay-text-pending font-semibold">{board.pendingCount}</span>
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {menu ? (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          ref={menuRef}
          style={{
            left: posicion?.left ?? menu.x,
            top: posicion?.top ?? menu.y,
            // Se dibuja recién cuando se sabe dónde: medir primero evita el
            // parpadeo de verlo aparecer en un lado y saltar al otro.
            visibility: posicion ? "visible" : "hidden",
          }}
          className="anim-menu bg-ink-900 fixed z-50 w-56 overflow-hidden rounded-xl border border-white/12 shadow-[0_16px_50px_-12px_rgb(0_0_0/0.9)]"
        >
          <div className="border-b border-white/[0.07] px-3 py-2">
            <p className="text-chalk-400 text-[0.6875rem] font-bold tracking-wider uppercase">
              Estado del pago
            </p>
            <p className="text-chalk-600 truncate text-xs">
              {menu.name} · <span className="tnum">{formatMoney(menu.amount)}</span>
            </p>
          </div>

          {
            <>
              <button
                type="button"
                role="menuitem"
                disabled={menu.paid}
                onClick={() => {
                  const target = menu;
                  setMenu(null);
                  toggle(target.staffMemberId, true);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-white/[0.06] disabled:opacity-40"
              >
                <span className="pay-dot pay-dot-paid" />
                <span className="text-chalk-100 flex-1 text-xs font-medium">Pagado</span>
                {menu.paid ? (
                  <Icon name="check" size={13} className="pay-text-paid shrink-0" />
                ) : null}
              </button>

              <button
                type="button"
                role="menuitem"
                disabled={!menu.paid || !canVoid}
                onClick={() => {
                  const target = menu;
                  setMenu(null);
                  toggle(target.staffMemberId, false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-white/[0.06] disabled:opacity-40"
              >
                <span className="pay-dot pay-dot-pending" />
                <span className="text-chalk-100 flex-1 text-xs font-medium">Falta pagar</span>
                {!menu.paid ? (
                  <Icon name="check" size={13} className="pay-text-pending shrink-0" />
                ) : null}
              </button>

              {menu.paid && !canVoid ? (
                <p className="text-chalk-600 border-t border-white/[0.07] px-3 py-2 text-[0.625rem] leading-snug">
                  Para desmarcar un pago hace falta el permiso de anulación.
                </p>
              ) : null}

              {!isClosed ? (
                <p className="text-chalk-600 border-t border-white/[0.07] px-3 py-2 text-[0.625rem] leading-snug">
                  El período sigue abierto: si después cambian las horas, el tablero avisa que el
                  importe se movió.
                </p>
              ) : null}
            </>
          }
        </div>
      ) : null}
    </div>
  );
}
