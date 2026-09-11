"use client";

import { useState } from "react";

import { Icon } from "@/components/layout/icons";
import { ActionForm, Dialog, SubmitButton } from "@/components/ui/interactive";
import { Button, Callout, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { formatMoney, parseMoneyInput } from "@/domain/money";
import { ROLE_LIST, roleLabel } from "@/domain/permissions";
import {
  createUserAction,
  resetPasswordAction,
  updateRateAction,
  updateSettingAction,
  updateUserAction,
} from "@/server/actions";

export function EditRateDialog({
  rank,
  label,
  currentRate,
}: {
  readonly rank: string;
  readonly label: string;
  readonly currentRate: number;
}) {
  const [value, setValue] = useState(String(currentRate));
  const parsed = parseMoneyInput(value);

  return (
    <Dialog
      title={"Tarifa de " + rank}
      description={label}
      width="sm"
      trigger={(open) => (
        <Button variant="ghost" size="sm" onClick={open}>
          Cambiar
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={updateRateAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="rank" value={rank} />
              <input type="hidden" name="ratePerHour" value={parsed ?? ""} />

              <Callout tone="warning" title="Sólo afecta a los períodos abiertos">
                Las liquidaciones ya cerradas conservan la tarifa que tenían congelada. Una
                liquidación del mes pasado no cambia de importe por esto.
              </Callout>

              <div>
                <span className="label">Tarifa por hora</span>
                <Input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  inputMode="numeric"
                  placeholder="1500000"
                  aria-label="Tarifa por hora"
                />
                <p className="text-chalk-500 mt-1.5 text-xs">
                  Actual: <span className="tnum">{formatMoney(currentRate)}</span>
                  {parsed !== null && parsed !== currentRate ? (
                    <>
                      {" → nueva: "}
                      <span className="tnum text-imperial-400 font-semibold">
                        {formatMoney(parsed)}
                      </span>
                    </>
                  ) : null}
                </p>
                {fieldError("ratePerHour") ? (
                  <p className="text-imperial-400 mt-1 text-xs">
                    {fieldError("ratePerHour")?.join(" ")}
                  </p>
                ) : null}
              </div>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={2}
                  required
                  placeholder="Ajuste acordado con la administración."
                />
              </Field>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton disabled={parsed === null || parsed === currentRate}>
                  Guardar tarifa
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

function RoleOptions({ maxRank }: { readonly maxRank: number }) {
  return (
    <>
      {ROLE_LIST.filter((role) => role.rank < maxRank).map((role) => (
        <option key={role.role} value={role.role}>
          {role.label}
        </option>
      ))}
    </>
  );
}

export function CreateUserDialog({ actorRank }: { readonly actorRank: number }) {
  return (
    <Dialog
      title="Crear usuario del sistema"
      description="Es una cuenta para entrar al panel, distinta del rango de staff."
      trigger={(open) => (
        <Button size="sm" onClick={open}>
          <Icon name="plus" size={15} />
          Nuevo usuario
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={createUserAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <Field label="Usuario" name="username" required error={fieldError("username")}>
                <Input
                  id="username"
                  name="username"
                  required
                  maxLength={32}
                  autoCapitalize="none"
                  placeholder="juan"
                />
              </Field>

              <Field label="Nombre visible" name="displayName" error={fieldError("displayName")}>
                <Input id="displayName" name="displayName" maxLength={80} placeholder="Juan" />
              </Field>

              <Field
                label="Rol"
                name="role"
                required
                error={fieldError("role")}
                hint="Sólo podés asignar roles por debajo del tuyo."
              >
                <Select id="role" name="role" required defaultValue="MANAGER">
                  <RoleOptions maxRank={actorRank} />
                </Select>
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Contraseña" name="password" required error={fieldError("password")}>
                  <Input id="password" name="password" type="password" required minLength={10} />
                </Field>
                <Field
                  label="Repetir"
                  name="confirmPassword"
                  required
                  error={fieldError("confirmPassword")}
                >
                  <Input id="confirmPassword" name="confirmPassword" type="password" required />
                </Field>
              </div>

              <Callout tone="neutral">
                Mínimo 10 caracteres, con mayúscula, minúscula y número.
              </Callout>

              <label className="text-chalk-300 flex cursor-pointer items-center gap-2.5 text-xs">
                <input
                  type="checkbox"
                  name="mustChangePassword"
                  value="true"
                  defaultChecked
                  className="h-4 w-4 accent-[var(--color-imperial-500)]"
                />
                Obligar a cambiar la contraseña en el primer ingreso
              </label>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={close}>
                  Cancelar
                </Button>
                <SubmitButton>Crear usuario</SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      )}
    </Dialog>
  );
}

export function EditUserDialog({
  user,
  actorRank,
}: {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string | null;
    readonly role: string;
    readonly active: boolean;
    readonly version: number;
  };
  readonly actorRank: number;
}) {
  return (
    <Dialog
      title={"Editar a " + user.username}
      description={"Rol actual: " + roleLabel(user.role)}
      width="sm"
      trigger={(open) => (
        <Button variant="ghost" size="icon" onClick={open} aria-label="Editar" title="Editar">
          <Icon name="settings" size={15} />
        </Button>
      )}
    >
      {(close) => (
        <ActionForm action={updateUserAction} onSuccess={close} className="flex flex-col gap-4">
          {({ fieldError }) => (
            <>
              <input type="hidden" name="id" value={user.id} />
              <input type="hidden" name="expectedVersion" value={user.version} />

              <Field label="Nombre visible" name="displayName" error={fieldError("displayName")}>
                <Input id="displayName" name="displayName" defaultValue={user.displayName ?? ""} />
              </Field>

              <Field label="Rol" name="role" required error={fieldError("role")}>
                <Select id="role" name="role" defaultValue={user.role} required>
                  <RoleOptions maxRank={actorRank} />
                </Select>
              </Field>

              <label className="text-chalk-300 flex cursor-pointer items-center gap-2.5 text-xs">
                <input
                  type="checkbox"
                  name="active"
                  value="true"
                  defaultChecked={user.active}
                  className="h-4 w-4 accent-[var(--color-imperial-500)]"
                />
                Cuenta activa (al desactivarla se cierran todas sus sesiones)
              </label>

              <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                <Textarea id="reason" name="reason" rows={2} required />
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

export function ResetPasswordDialog({
  userId,
  username,
}: {
  readonly userId: string;
  readonly username: string;
}) {
  const [temporary, setTemporary] = useState<string | null>(null);

  return (
    <Dialog
      title={"Restablecer la contraseña de " + username}
      width="sm"
      trigger={(open) => (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setTemporary(null);
            open();
          }}
          aria-label="Restablecer contraseña"
          title="Restablecer contraseña"
        >
          <Icon name="lock" size={15} />
        </Button>
      )}
    >
      {(close) =>
        temporary ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning" title="Copiala ahora">
              No se vuelve a mostrar. Pasásela por un canal privado; en el primer ingreso el sistema
              le va a pedir que la cambie.
            </Callout>
            <p className="mono bg-ink-950 text-jade-400 rounded-lg border border-white/15 px-3 py-3 text-center text-base font-bold tracking-widest select-all">
              {temporary}
            </p>
            <Button type="button" onClick={close}>
              Listo
            </Button>
          </div>
        ) : (
          <ActionForm
            action={resetPasswordAction}
            toastOnSuccess={false}
            onSuccess={(state) => {
              const data = state.status === "success" ? state.data : null;
              const password =
                data && typeof data === "object" && "temporaryPassword" in data
                  ? String((data as { temporaryPassword: unknown }).temporaryPassword)
                  : null;
              setTemporary(password);
            }}
            className="flex flex-col gap-4"
          >
            {({ fieldError }) => (
              <>
                <input type="hidden" name="id" value={userId} />

                <Callout tone="neutral">
                  Se genera una contraseña temporal y se muestra una sola vez.
                </Callout>

                <Field label="Motivo" name="reason" required error={fieldError("reason")}>
                  <Textarea
                    id="reason"
                    name="reason"
                    rows={2}
                    required
                    placeholder="Olvidó la contraseña."
                  />
                </Field>

                <label className="text-chalk-300 flex cursor-pointer items-center gap-2.5 text-xs">
                  <input
                    type="checkbox"
                    name="revokeSessions"
                    value="true"
                    defaultChecked
                    className="h-4 w-4 accent-[var(--color-imperial-500)]"
                  />
                  Cerrar todas sus sesiones abiertas
                </label>

                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={close}>
                    Cancelar
                  </Button>
                  <SubmitButton variant="danger">Restablecer</SubmitButton>
                </div>
              </>
            )}
          </ActionForm>
        )
      }
    </Dialog>
  );
}

export function SettingRow({
  setting,
}: {
  readonly setting: {
    readonly key: string;
    readonly value: string;
    readonly valueType: string;
    readonly label: string;
    readonly description: string | null;
  };
}) {
  return (
    <ActionForm action={updateSettingAction} className="flex flex-wrap items-end gap-3 px-4 py-3">
      {({ fieldError }) => (
        <>
          <input type="hidden" name="key" value={setting.key} />
          <div className="min-w-0 flex-1">
            <p className="text-chalk-100 text-sm font-medium">{setting.label}</p>
            {setting.description ? (
              <p className="text-chalk-500 mt-0.5 text-xs">{setting.description}</p>
            ) : null}
            {fieldError("value") ? (
              <p className="text-imperial-400 mt-1 text-xs">{fieldError("value")?.join(" ")}</p>
            ) : null}
          </div>
          {setting.valueType === "boolean" ? (
            <Select name="value" defaultValue={setting.value} className="h-9 w-32 py-0 text-xs">
              <option value="true">Sí</option>
              <option value="false">No</option>
            </Select>
          ) : (
            <Input
              name="value"
              defaultValue={setting.value}
              inputMode={setting.valueType === "number" ? "numeric" : "text"}
              className="h-9 w-48 py-0 text-xs"
            />
          )}
          <SubmitButton size="sm" variant="secondary" pendingLabel="…">
            Guardar
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
