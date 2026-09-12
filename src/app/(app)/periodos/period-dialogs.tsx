"use client";

import { useState } from "react";

import { Icon } from "@/components/layout/icons";
import { ActionForm, ConfirmField, Dialog, SubmitButton } from "@/components/ui/interactive";
import { Button, Callout, Field, Input, Textarea } from "@/components/ui/primitives";
import { formatMoney } from "@/domain/money";
import { formatPeriodLabel, periodLengthInDays } from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import {
  closeWeekAction,
  createWeekAction,
  deleteWeekAction,
  reopenWeekAction,
  updateWeekAction,
} from "@/server/actions";

export function CreatePeriodDialog({
  suggestedStart,
  suggestedEnd,
}: {
  readonly suggestedStart: string;
  readonly suggestedEnd: string;
}) {
  const [start, setStart] = useState(suggestedStart);
  const [end, setEnd] = useState(suggestedEnd);

  const days = start && end && start <= end ? periodLengthInDays(start, end) : 0;

  return (
    <Dialog
      title="Abrir un período nuevo"
      description="Las fechas las definís vos: no tiene por qué ser de lunes a domingo."
      trigger={(open) => (
        <Button size="sm" onClick={open}>
          <Icon name="plus" size={15} />
          Nuevo período
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={createWeekAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Desde" name="startDate" required error={fieldError("startDate")}>
                  <Input
                    id="startDate"
                    name="startDate"
                    type="date"
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                    required
                  />
                </Field>
                <Field label="Hasta" name="endDate" required error={fieldError("endDate")}>
                  <Input
                    id="endDate"
                    name="endDate"
                    type="date"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                    required
                  />
                </Field>
              </div>

              {days > 0 ? (
                <Callout tone={days > 14 ? "warning" : "neutral"}>
                  El período abarca <strong>{days} días</strong>
                  {days > 14
                    ? ", más de lo habitual para una liquidación. Verificá las fechas."
                    : "."}
                </Callout>
              ) : null}

              <Field
                label="Etiqueta"
                name="label"
                error={fieldError("label")}
                hint="Opcional, para reconocerlo rápido. Por ejemplo: Semana 36."
              >
                <Input
                  id="label"
                  name="label"
                  maxLength={80}
                  placeholder="Semana 36 — Septiembre"
                />
              </Field>

              <Field label="Notas" name="notes" error={fieldError("notes")}>
                <Textarea id="notes" name="notes" rows={2} maxLength={1000} />
              </Field>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
                <input
                  type="checkbox"
                  name="seedActiveStaff"
                  value="true"
                  defaultChecked
                  className="mt-0.5 h-4 w-4 accent-[var(--color-imperial-500)]"
                />
                <span className="text-chalk-300 text-xs leading-relaxed">
                  <strong className="text-chalk-100 block">
                    Incorporar a todo el staff activo
                  </strong>
                  Arrancan en cero horas. Evita que alguien quede fuera de la liquidación por
                  olvido.
                </span>
              </label>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Abrir período</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export interface CloseSummary {
  readonly weekId: string;
  readonly version: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly memberCount: number;
  readonly membersWithHours: number;
  readonly warnings: readonly { readonly kind: string; readonly message: string }[];
}

/**
 * Cierre del período.
 *
 * Antes de confirmar se muestran las advertencias detectadas (gente en cero,
 * horas desmedidas, fechas fuera de rango). No bloquean el cierre, pero obligan
 * a verlas: el objetivo es que nadie congele una liquidación con un error que
 * saltaba a la vista.
 */
export function ClosePeriodDialog({ summary }: { readonly summary: CloseSummary }) {
  const hasWarnings = summary.warnings.length > 0;

  return (
    <Dialog
      title="Cerrar el período"
      description={formatPeriodLabel(summary.startDate, summary.endDate)}
      trigger={(open) => (
        <Button size="sm" variant="secondary" onClick={open}>
          <Icon name="lock" size={15} />
          Cerrar período
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={closeWeekAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={summary.weekId} />
              <input type="hidden" name="expectedVersion" value={summary.version} />
              <input type="hidden" name="acknowledgeWarnings" value="true" />

              <Callout tone="neutral" title="Qué pasa al cerrar">
                Las horas, el rango, la tarifa y el importe de cada miembro quedan congelados. A
                partir de ahí, ningún cambio futuro de rango o de tarifa puede modificar esta
                liquidación. Reabrir el período después requiere un permiso especial.
              </Callout>

              <div className="grid grid-cols-3 gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div>
                  <p className="overline">Horas</p>
                  <p className="tnum text-chalk-50 mt-0.5 text-sm font-bold">
                    {formatMinutes(summary.totalMinutes)}
                  </p>
                </div>
                <div>
                  <p className="overline">Importe</p>
                  <p className="tnum text-imperial-400 mt-0.5 text-sm font-bold">
                    {formatMoney(summary.totalAmount)}
                  </p>
                </div>
                <div>
                  <p className="overline">Miembros</p>
                  <p className="tnum text-chalk-50 mt-0.5 text-sm font-bold">
                    {summary.membersWithHours} / {summary.memberCount}
                  </p>
                </div>
              </div>

              {hasWarnings ? (
                <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.07] p-3">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                    <Icon name="alert" size={14} />
                    Revisá esto antes de cerrar
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {summary.warnings.map((warning, index) => (
                      <li
                        key={index}
                        className="text-[0.6875rem] leading-relaxed text-amber-100/85"
                      >
                        · {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <Callout tone="success">
                  No se detectaron inconsistencias. El período está listo para cerrarse.
                </Callout>
              )}

              <ConfirmField word="CERRAR" error={fieldError("confirmation")} />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton pendingLabel="Cerrando…">Cerrar y congelar</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function ReopenPeriodDialog({
  weekId,
  version,
  label,
  paidCount,
}: {
  readonly weekId: string;
  readonly version: number;
  readonly label: string;
  readonly paidCount: number;
}) {
  return (
    <Dialog
      title="Reabrir el período"
      description={label}
      width="sm"
      trigger={(open) => (
        <Button size="sm" variant="danger" onClick={open}>
          Reabrir
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={reopenWeekAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={weekId} />
              <input type="hidden" name="expectedVersion" value={version} />

              <Callout tone="danger" title="Esto descongela datos históricos">
                Las liquidaciones vuelven a poder cambiar. Queda registrado quién reabrió, cuándo y
                por qué, y el período va a mostrar para siempre que fue reabierto.
                {paidCount > 0 ? (
                  <>
                    <br />
                    <br />
                    <strong>
                      Atención: ya hay {paidCount} pago(s) registrado(s) en este período.
                    </strong>{" "}
                    Si las horas cambian, los importes abonados dejarán de coincidir.
                  </>
                ) : null}
              </Callout>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={3}
                  required
                  placeholder="Faltaban cargar las horas del domingo de dos moderadores."
                />
              </Field>

              <ConfirmField word="REABRIR" error={fieldError("confirmation")} />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton variant="danger" pendingLabel="Reabriendo…">
                  Reabrir período
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

/**
 * Borrar un período.
 *
 * El botón está siempre; lo que cambia es lo que dice el diálogo. Si el
 * período tiene algo adentro, adentro se explica qué tiene y por qué no se
 * borra, en vez de esconder el botón y dejar a alguien buscándolo. Un botón
 * que desaparece sin explicación se lee como que la función no existe.
 */
export function DeletePeriodDialog({
  weekId,
  version,
  label,
  blocker,
  canDelete,
  seededCount,
}: {
  readonly weekId: string;
  readonly version: number;
  readonly label: string;
  readonly blocker: string | null;
  readonly canDelete: boolean;
  readonly seededCount: number;
}) {
  return (
    <Dialog
      title="Borrar el período"
      description={label}
      width="sm"
      trigger={(open) => (
        <Button size="sm" variant="ghost" onClick={open} title="Borrar el período">
          <Icon name="trash" size={14} />
          <span className="sr-only">Borrar</span>
        </Button>
      )}
    >
      {(close) =>
        !canDelete ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning" title="Este período no está vacío">
              {blocker}
            </Callout>

            <p className="text-chalk-500 text-xs leading-relaxed">
              Sólo se borran los períodos que no contienen nada — el que se creó con la fecha mal
              tipeada, o el de más. Todo lo demás se cierra o se reabre, pero no se hace
              desaparecer: son las horas que cada uno va a cobrar.
            </p>

            <div className="flex justify-end">
              <Button type="button" variant="ghost" onClick={close}>
                Entendido
              </Button>
            </div>
          </div>
        ) : (
          <ActionForm action={deleteWeekAction} onSuccess={close} className="flex flex-col gap-4">
            {({ fieldError }) => (
              <>
                <input type="hidden" name="id" value={weekId} />
                <input type="hidden" name="expectedVersion" value={version} />

                <Callout tone="danger" title="Esto no se puede deshacer">
                  El período desaparece de la lista y de los filtros. No hay papelera ni forma de
                  recuperarlo: habría que crearlo de nuevo.
                  {seededCount > 0 ? (
                    <>
                      <br />
                      <br />
                      Se van con él las <strong>{seededCount}</strong> filas de planilla sembradas
                      en cero. Ninguna tiene horas cargadas.
                    </>
                  ) : null}
                </Callout>

                <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                  <Textarea
                    id="reason"
                    name="reason"
                    rows={3}
                    required
                    placeholder="Lo creé con las fechas de la semana equivocada."
                  />
                </Field>

                <ConfirmField word="BORRAR" error={fieldError("confirmation")} />

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={close}>
                    Cancelar
                  </Button>
                  <SubmitButton variant="danger" pendingLabel="Borrando…">
                    Borrar período
                  </SubmitButton>
                </div>
              </>
            )}
          </ActionForm>
        )
      }
    </Dialog>
  );
}

/**
 * Editar la etiqueta y las notas de un período.
 *
 * La etiqueta —"Semana 2 - septiembre"— sólo se podía escribir al crearlo. Si
 * salía mal tipeada, o si después había algo que anotar sobre ese período, no
 * quedaba forma de tocarla: había que borrar y volver a crear, y eso con horas
 * adentro no se puede.
 *
 * Las fechas no se editan acá a propósito. Mover el rango de un período con
 * horas cargadas deja entradas fuera de sus propias fechas, y el cálculo pasa a
 * mentir sin avisar. Si las fechas están mal, el período va vacío y se rehace.
 */
export function EditPeriodDialog({
  weekId,
  version,
  label,
  notes,
  periodLabel,
}: {
  readonly weekId: string;
  readonly version: number;
  readonly label: string | null;
  readonly notes: string | null;
  readonly periodLabel: string;
}) {
  return (
    <Dialog
      title="Editar el período"
      description={periodLabel}
      width="sm"
      trigger={(open) => (
        <Button size="sm" variant="ghost" onClick={open} title="Editar etiqueta y notas">
          <Icon name="pencil" size={14} />
          <span className="sr-only">Editar</span>
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={updateWeekAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={weekId} />
              <input type="hidden" name="expectedVersion" value={version} />

              <Field
                label="Etiqueta"
                name="label"
                hint="Cómo se lo nombra en la lista. Las fechas se muestran solas."
                error={fieldError("label")}
              >
                <Input
                  id="label"
                  name="label"
                  defaultValue={label ?? ""}
                  maxLength={80}
                  placeholder="Semana 2 - septiembre"
                />
              </Field>

              <Field
                label="Notas"
                name="notes"
                hint="Queda en el período. No lo ve nadie de afuera."
                error={fieldError("notes")}
              >
                <Textarea
                  id="notes"
                  name="notes"
                  rows={3}
                  maxLength={1000}
                  defaultValue={notes ?? ""}
                  placeholder="Semana del evento; se pagó aparte el bono."
                />
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton pendingLabel="Guardando…">Guardar</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}
