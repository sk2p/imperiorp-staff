"use client";

import { useState } from "react";

import { Icon } from "@/components/layout/icons";
import { ActionForm, ConfirmField, Dialog, SubmitButton } from "@/components/ui/interactive";
import { Button, Callout, Field, cn } from "@/components/ui/primitives";
import { GROUP_DEFINITIONS, readableTextOn, type StaffGroup } from "@/domain/groups";
import { formatMoney, parseMoneyInput } from "@/domain/money";
import { RANK_LIST } from "@/domain/ranks";
import { resetWeekAction, updateGroupRatesAction, updateRankColorsAction } from "@/server/actions";

/**
 * Ajustes de la planilla: cuánto cobra cada grupo, con qué color se ve cada
 * rango y cómo se vacía la semana.
 */

/* -------------------------------------------------------------------------- */
/* Pagos por categoría                                                        */
/* -------------------------------------------------------------------------- */

export function GroupRatesForm({ rates }: { readonly rates: Record<StaffGroup, number> }) {
  const [values, setValues] = useState<Record<string, string>>({
    LOW_STAFF: String(rates.LOW_STAFF),
    MID_STAFF: String(rates.MID_STAFF),
    HIGH_STAFF: String(rates.HIGH_STAFF),
  });

  const order: StaffGroup[] = ["LOW_STAFF", "MID_STAFF", "HIGH_STAFF"];

  return (
    <ActionForm action={updateGroupRatesAction} className="flex flex-col gap-4 p-4">
      {({ fieldError }) => (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {order.map((group) => {
              const parsed = parseMoneyInput(values[group] ?? "");
              return (
                <Field
                  key={group}
                  label={GROUP_DEFINITIONS[group].label}
                  name={group}
                  error={fieldError(group)}
                  hint={parsed !== null ? formatMoney(parsed) + " por hora" : "Importe inválido"}
                >
                  <input
                    id={group}
                    name={group}
                    inputMode="numeric"
                    value={values[group] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [group]: event.target.value }))
                    }
                    className="field tnum"
                  />
                </Field>
              );
            })}
          </div>

          <Callout tone="warning">
            La tarifa se aplica a los tres rangos de cada familia. Sólo cambia los períodos
            <strong> abiertos</strong>: las liquidaciones ya cerradas conservan la suya congelada.
          </Callout>

          <SubmitButton className="self-end">Guardar pagos</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

/* -------------------------------------------------------------------------- */
/* Colores de rangos                                                          */
/* -------------------------------------------------------------------------- */

export function RankColorsForm({
  colors,
}: {
  readonly colors: readonly { readonly rank: string; readonly color: string }[];
}) {
  const [current, setCurrent] = useState<Record<string, string>>(
    Object.fromEntries(colors.map((entry) => [entry.rank, entry.color])),
  );

  return (
    <ActionForm action={updateRankColorsAction} className="flex flex-col gap-4 p-4">
      {({ fieldError }) => (
        <>
          {/* Cada par viaja como RANGO=#rrggbb: un único campo repetido en vez
              de un campo por rango, que multiplicaría el formulario por once. */}
          {Object.entries(current).map(([rank, color]) => (
            <input key={rank} type="hidden" name="colors[]" value={rank + "=" + color} />
          ))}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {RANK_LIST.map((definition) => {
              const color = current[definition.rank] ?? "#6f747d";
              return (
                <label
                  key={definition.rank}
                  className="interactive flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2"
                >
                  <span className="min-w-0">
                    <span
                      className="inline-flex rounded-md px-2 py-0.5 text-[0.625rem] font-bold"
                      style={{ backgroundColor: color, color: readableTextOn(color) }}
                    >
                      {definition.rank}
                    </span>
                    <span className="text-chalk-600 mt-1 block truncate text-[0.625rem]">
                      {definition.name}
                    </span>
                  </span>
                  <input
                    type="color"
                    value={color}
                    onChange={(event) =>
                      setCurrent((prev) => ({ ...prev, [definition.rank]: event.target.value }))
                    }
                    aria-label={"Color de " + definition.rank}
                    className="color-input shrink-0"
                  />
                </label>
              );
            })}
          </div>

          {fieldError("colors") ? (
            <p className="text-imperial-400 text-xs">{fieldError("colors")?.join(" ")}</p>
          ) : null}

          <SubmitButton className="self-end">Guardar colores</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

/* -------------------------------------------------------------------------- */
/* Rangos y agrupación                                                        */
/* -------------------------------------------------------------------------- */

export function RankGroupsPanel({
  colors,
}: {
  readonly colors: readonly { readonly rank: string; readonly color: string }[];
}) {
  const byRank = new Map(colors.map((entry) => [entry.rank, entry.color]));

  return (
    <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {[...RANK_LIST].reverse().map((definition) => {
        const group =
          definition.category === "SOPORTE"
            ? "LOW_STAFF"
            : definition.category === "MODERACION"
              ? "MID_STAFF"
              : "HIGH_STAFF";
        const color = byRank.get(definition.rank) ?? "#6f747d";

        return (
          <div
            key={definition.rank}
            className="flex flex-col items-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
          >
            <span
              className="rounded-md px-2 py-0.5 text-[0.6875rem] font-bold"
              style={{ backgroundColor: color, color: readableTextOn(color) }}
            >
              {definition.rank}
            </span>
            <span
              className={cn(
                "text-[0.625rem] font-semibold tracking-wider uppercase",
                GROUP_DEFINITIONS[group].accent,
              )}
            >
              {GROUP_DEFINITIONS[group].label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reinicio de la semana                                                      */
/* -------------------------------------------------------------------------- */

export function ResetWeekPanel({
  weekId,
  weekLabel,
  loadedHours,
}: {
  readonly weekId: string | null;
  readonly weekLabel: string;
  readonly loadedHours: string;
}) {
  if (!weekId) {
    return (
      <div className="p-4">
        <Callout tone="neutral">
          No hay ningún período abierto que reiniciar. Creá uno desde <strong>Períodos</strong>.
        </Callout>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-chalk-400 text-xs leading-relaxed">
        Deja todas las horas de <strong className="text-chalk-200">{weekLabel}</strong> en 0:00 y
        quita las marcas de estado. Los miembros permanecen en la planilla.
      </p>
      <p className="text-chalk-600 text-[0.6875rem]">
        Actualmente hay <span className="tnum text-chalk-300 font-semibold">{loadedHours}</span>{" "}
        cargadas. Nada se borra: las entradas quedan anuladas y siguen visibles en el historial.
      </p>

      <Dialog
        title="Reiniciar las horas del período"
        description={weekLabel}
        width="sm"
        trigger={(open) => (
          <Button variant="danger" size="sm" onClick={open} className="self-start">
            <Icon name="alert" size={15} />
            Reiniciar horas de la semana
          </Button>
        )}
      >
        {(close) => (
          <ActionForm action={resetWeekAction} onSuccess={close} className="flex flex-col gap-4">
            {({ fieldError }) => (
              <>
                <input type="hidden" name="weekId" value={weekId} />

                <Callout tone="danger" title="Qué va a pasar">
                  Todas las horas del período vuelven a 0:00 y se quitan las marcas de inactivo,
                  justificado y anulado. Los miembros siguen en la lista.
                  <br />
                  <br />
                  Es reversible sólo en el sentido de que queda registrado: vas a poder ver en el
                  historial qué había cargado antes y quién lo reinició, pero los totales se
                  pierden.
                </Callout>

                <ConfirmField word="REINICIAR" error={fieldError("confirmation")} />

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={close}>
                    Cancelar
                  </Button>
                  <SubmitButton variant="danger" pendingLabel="Reiniciando…">
                    Reiniciar la semana
                  </SubmitButton>
                </div>
              </>
            )}
          </ActionForm>
        )}
      </Dialog>
    </div>
  );
}
