"use client";

import { Icon } from "@/components/layout/icons";
import { ActionForm, ConfirmField, Dialog, SubmitButton } from "@/components/ui/interactive";
import { Button, Callout, Field, Input, Textarea } from "@/components/ui/primitives";
import { formatMinutes } from "@/domain/time";
import { updateHourEntryAction, voidHourEntryAction } from "@/server/actions";

export interface EditableEntry {
  readonly id: string;
  readonly staffName: string;
  readonly workDate: string;
  readonly minutes: number;
  readonly reason: string;
  readonly version: number;
}

/**
 * Corrección de una entrada.
 *
 * Muestra el valor original al lado del nuevo y exige un motivo: es
 * exactamente lo que después permite responder "¿por qué a Martin le figuraban
 * 16 h 30 m y ahora 18 h 30 m?".
 */
export function EditEntryDialog({
  entry,
  weekStart,
  weekEnd,
}: {
  readonly entry: EditableEntry;
  readonly weekStart: string;
  readonly weekEnd: string;
}) {
  const hours = Math.floor(entry.minutes / 60);
  const minutes = entry.minutes % 60;

  return (
    <Dialog
      title={"Corregir horas de " + entry.staffName}
      description="El valor anterior, el nuevo y el motivo quedan registrados en la auditoría."
      trigger={(open) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={open}
          aria-label="Corregir entrada"
          title="Corregir"
        >
          <Icon name="settings" size={15} />
        </Button>
      )}
    >
      {(close) => (
        <ActionForm
          action={updateHourEntryAction}
          onSuccess={close}
          className="flex flex-col gap-4"
        >
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={entry.id} />
              <input type="hidden" name="expectedVersion" value={entry.version} />

              <Callout tone="neutral">
                Valor actual:{" "}
                <strong className="tnum text-chalk-100">{formatMinutes(entry.minutes)}</strong> el{" "}
                {entry.workDate} — {entry.reason}
              </Callout>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Horas" name="hours" required error={fieldError("hours")}>
                  <Input
                    id="hours"
                    name="hours"
                    type="number"
                    min={0}
                    max={24}
                    defaultValue={hours}
                    required
                  />
                </Field>
                <Field label="Minutos" name="minutes" required error={fieldError("minutes")}>
                  <Input
                    id="minutes"
                    name="minutes"
                    type="number"
                    min={0}
                    max={59}
                    defaultValue={minutes}
                    required
                  />
                </Field>
              </div>

              <Field label="Fecha" name="workDate" required error={fieldError("workDate")}>
                <Input
                  id="workDate"
                  name="workDate"
                  type="date"
                  min={weekStart}
                  max={weekEnd}
                  defaultValue={entry.workDate}
                  required
                />
              </Field>

              <Field label="Qué hizo" name="reason" required error={fieldError("reason")}>
                <Textarea id="reason" name="reason" rows={2} defaultValue={entry.reason} required />
              </Field>

              <Field
                label="Motivo de la corrección"
                name="changeReason"
                required
                error={fieldError("changeReason")}
                hint="Explicá por qué se modifica. Mínimo 5 caracteres."
              >
                <Textarea
                  id="changeReason"
                  name="changeReason"
                  rows={2}
                  required
                  placeholder="Faltaban 2 horas del turno del sábado."
                />
              </Field>

              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Guardar corrección</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

/** Anulación de una entrada. No borra: marca y explica. */
export function VoidEntryDialog({ entry }: { readonly entry: EditableEntry }) {
  return (
    <Dialog
      title="Anular entrada"
      description="La entrada no se elimina: queda marcada como anulada y deja de sumar."
      width="sm"
      trigger={(open) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={open}
          aria-label="Anular entrada"
          title="Anular"
        >
          <Icon name="alert" size={15} />
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={voidHourEntryAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={entry.id} />
              <input type="hidden" name="expectedVersion" value={entry.version} />

              <Callout tone="danger">
                Se van a anular <strong>{formatMinutes(entry.minutes)}</strong> de{" "}
                <strong>{entry.staffName}</strong> ({entry.workDate}). El total del período baja en
                esa cantidad.
              </Callout>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={3}
                  required
                  placeholder="Se cargó por error al miembro equivocado."
                />
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton variant="danger" pendingLabel="Anulando…">
                  Anular entrada
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export { ConfirmField };
