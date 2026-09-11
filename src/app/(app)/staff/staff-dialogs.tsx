"use client";

import { Icon } from "@/components/layout/icons";
import { ActionForm, ConfirmField, Dialog, SubmitButton } from "@/components/ui/interactive";
import { Button, Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { RANK_LIST } from "@/domain/ranks";
import {
  archiveStaffAction,
  changeRankAction,
  createStaffAction,
  restoreStaffAction,
  updateStaffAction,
} from "@/server/actions";

export interface StaffRow {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly inGameId: string | null;
  readonly discordTag: string | null;
  readonly joinedAt: string | null;
  readonly notes: string | null;
  readonly version: number;
}

function RankOptions() {
  return (
    <>
      {RANK_LIST.map((rank) => (
        <option key={rank.rank} value={rank.rank}>
          {rank.rank} — {rank.name}
        </option>
      ))}
    </>
  );
}

export function CreateStaffDialog() {
  return (
    <Dialog
      title="Dar de alta un miembro"
      description="El rango define la tarifa por hora que se le aplicará de ahora en adelante."
      trigger={(open) => (
        <Button size="sm" onClick={open}>
          <Icon name="plus" size={15} />
          Nuevo miembro
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={createStaffAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <Field label="Nombre" name="name" required error={fieldError("name")}>
                <Input
                  id="name"
                  name="name"
                  required
                  maxLength={60}
                  placeholder="Martin"
                  autoFocus
                />
              </Field>

              <Field
                label="Rango"
                name="rank"
                required
                error={fieldError("rank")}
                hint="Determina la tarifa. Cambiarlo más adelante no altera las liquidaciones ya cerradas."
              >
                <Select id="rank" name="rank" required defaultValue="SDP">
                  <RankOptions />
                </Select>
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Dar de alta</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function EditStaffDialog({ member }: { readonly member: StaffRow }) {
  return (
    <Dialog
      title={"Editar a " + member.name}
      description="Para cambiar el rango usá la acción específica: deja su propio registro."
      trigger={(open) => (
        <Button variant="ghost" size="icon" onClick={open} aria-label="Editar" title="Editar">
          <Icon name="settings" size={15} />
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={updateStaffAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={member.id} />
              <input type="hidden" name="expectedVersion" value={member.version} />

              <Field label="Nombre" name="name" required error={fieldError("name")}>
                <Input id="name" name="name" defaultValue={member.name} required maxLength={60} />
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Guardar</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function ChangeRankDialog({ member }: { readonly member: StaffRow }) {
  return (
    <Dialog
      title={"Cambiar el rango de " + member.name}
      description="Afecta a los períodos abiertos. Las liquidaciones cerradas conservan su tarifa."
      width="sm"
      trigger={(open) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={open}
          aria-label="Cambiar rango"
          title="Cambiar rango"
        >
          <Icon name="crown" size={15} />
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={changeRankAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={member.id} />
              <input type="hidden" name="expectedVersion" value={member.version} />

              <Callout tone="neutral">
                Rango actual: <strong className="text-chalk-100">{member.rank}</strong>
              </Callout>

              <Field label="Nuevo rango" name="rank" required error={fieldError("rank")}>
                <Select id="rank" name="rank" required defaultValue={member.rank}>
                  <RankOptions />
                </Select>
              </Field>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={3}
                  required
                  placeholder="Ascenso por desempeño en el último mes."
                />
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Cambiar rango</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function ArchiveStaffDialog({ member }: { readonly member: StaffRow }) {
  return (
    <Dialog
      title={"Archivar a " + member.name}
      description="No se borra nada: el historial de horas, pagos y rangos queda intacto."
      width="sm"
      trigger={(open) => (
        <Button variant="ghost" size="icon" onClick={open} aria-label="Archivar" title="Archivar">
          <Icon name="alert" size={15} />
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={archiveStaffAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={member.id} />
              <input type="hidden" name="expectedVersion" value={member.version} />

              <Callout tone="warning" title="Qué pasa al archivar">
                Deja de aparecer en la carga de horas y en los períodos nuevos. Todo lo que ya tiene
                registrado se conserva y se sigue pudiendo consultar. Es reversible.
              </Callout>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={2}
                  required
                  placeholder="Se retiró del staff el 10/09."
                />
              </Field>

              <ConfirmField
                word={member.name.toUpperCase()}
                name="confirmName"
                label={'Escribí "' + member.name + '" para confirmar'}
                error={fieldError("confirmName")}
              />

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton variant="danger" pendingLabel="Archivando…">
                  Archivar miembro
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function RestoreStaffDialog({ member }: { readonly member: StaffRow }) {
  return (
    <Dialog
      title={"Reincorporar a " + member.name}
      width="sm"
      trigger={(open) => (
        <Button variant="ghost" size="sm" onClick={open}>
          Reincorporar
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={restoreStaffAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={member.id} />
              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={2}
                  required
                  placeholder="Vuelve al staff."
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Reincorporar</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}
