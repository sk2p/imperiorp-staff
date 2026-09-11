"use client";

import { Icon } from "@/components/layout/icons";
import {
  ActionForm,
  ConfirmField,
  Dialog,
  IdempotencyField,
  SubmitButton,
} from "@/components/ui/interactive";
import { Button, Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { formatMoney } from "@/domain/money";
import { formatMinutes } from "@/domain/time";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/validation/payments";
import { createBulkPaymentsAction, createPaymentAction, voidPaymentAction } from "@/server/actions";

function MethodSelect({ defaultValue = "in_game" }: { readonly defaultValue?: string }) {
  return (
    <Select id="method" name="method" defaultValue={defaultValue}>
      {PAYMENT_METHODS.map((method) => (
        <option key={method} value={method}>
          {PAYMENT_METHOD_LABELS[method]}
        </option>
      ))}
    </Select>
  );
}

export function PayDialog({
  weekId,
  staffMemberId,
  name,
  rank,
  minutes,
  amount,
}: {
  readonly weekId: string;
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly minutes: number;
  readonly amount: number;
}) {
  return (
    <Dialog
      title={"Pagar a " + name}
      description="Revisá el importe antes de confirmar."
      width="sm"
      trigger={(open) => (
        <Button size="sm" variant="success" onClick={open}>
          Pagar
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={createPaymentAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="weekId" value={weekId} />
              <input type="hidden" name="staffMemberId" value={staffMemberId} />
              <input type="hidden" name="expectedAmount" value={amount} />
              <IdempotencyField />

              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-chalk-100 text-sm font-medium">
                    {name} <span className="text-chalk-500 ml-1 text-xs">{rank}</span>
                  </span>
                  <span className="tnum text-chalk-500 text-xs">{formatMinutes(minutes)}</span>
                </div>
                <p className="tnum text-jade-400 mt-2 text-2xl font-bold">{formatMoney(amount)}</p>
              </div>

              <Field label="Método" name="method" error={fieldError("method")}>
                <MethodSelect />
              </Field>

              <Field
                label="Referencia"
                name="paymentReference"
                error={fieldError("paymentReference")}
                hint="Opcional: número de comprobante o transacción."
              >
                <Input id="paymentReference" name="paymentReference" maxLength={80} />
              </Field>

              <Field label="Notas" name="notes" error={fieldError("notes")}>
                <Textarea id="notes" name="notes" rows={2} maxLength={500} />
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton variant="success" pendingLabel="Registrando…">
                  Confirmar pago
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function BulkPayDialog({
  weekId,
  pendingIds,
  pendingCount,
  pendingAmount,
}: {
  readonly weekId: string;
  readonly pendingIds: readonly string[];
  readonly pendingCount: number;
  readonly pendingAmount: number;
}) {
  return (
    <Dialog
      title="Pagar todas las liquidaciones pendientes"
      description={pendingCount + " miembros por " + formatMoney(pendingAmount)}
      width="sm"
      trigger={(open) => (
        <Button size="sm" onClick={open}>
          <Icon name="wallet" size={15} />
          Pagar todo ({pendingCount})
        </Button>
      )}
    >
      {(close) => (
        <ActionForm
          action={createBulkPaymentsAction}
          onSuccess={close}
          className="flex flex-col gap-4"
        >
          {({ fieldError }) => (
            <>
              <input type="hidden" name="weekId" value={weekId} />
              <IdempotencyField />
              {pendingIds.map((id) => (
                <input key={id} type="hidden" name="staffMemberIds[]" value={id} />
              ))}

              <Callout tone="warning">
                Se van a registrar <strong>{pendingCount} pagos</strong> por un total de{" "}
                <strong>{formatMoney(pendingAmount)}</strong>. Las liquidaciones ya pagadas se
                saltean.
              </Callout>

              <Field label="Método" name="method" error={fieldError("method")}>
                <MethodSelect />
              </Field>

              <Field label="Notas" name="notes" error={fieldError("notes")}>
                <Textarea id="notes" name="notes" rows={2} maxLength={500} />
              </Field>

              <ConfirmField word="PAGAR" error={fieldError("confirmation")} />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton pendingLabel="Registrando…">Registrar los pagos</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function VoidPaymentDialog({
  paymentId,
  version,
  name,
  amount,
}: {
  readonly paymentId: string;
  readonly version: number;
  readonly name: string;
  readonly amount: number;
}) {
  return (
    <Dialog
      title="Anular pago"
      description="El pago no se borra: queda marcado como anulado y libera la liquidación."
      width="sm"
      trigger={(open) => (
        <Button size="sm" variant="danger" onClick={open}>
          Anular
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={voidPaymentAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={paymentId} />
              <input type="hidden" name="expectedVersion" value={version} />

              <Callout tone="danger">
                Se anula el pago de <strong>{formatMoney(amount)}</strong> a <strong>{name}</strong>
                . Después vas a poder registrar el correcto.
              </Callout>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={3}
                  required
                  placeholder="Se pagó un importe equivocado."
                />
              </Field>

              <ConfirmField word="ANULAR" error={fieldError("confirmation")} />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton variant="danger" pendingLabel="Anulando…">
                  Anular pago
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}
