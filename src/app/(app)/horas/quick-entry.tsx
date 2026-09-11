"use client";

import { useMemo, useState } from "react";

import { Icon } from "@/components/layout/icons";
import { ActionForm, SubmitButton } from "@/components/ui/interactive";
import { Field, Input, Select, Textarea, cn } from "@/components/ui/primitives";
import { formatMinutes, parseDurationInput, SUSPICIOUS_MINUTES_PER_ENTRY } from "@/domain/time";
import { createHourEntryAction } from "@/server/actions";

export interface StaffOption {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
}

/** Atajos que cubren la enorme mayoría de los turnos reales. */
const PRESETS = [30, 60, 90, 120, 180, 240] as const;

/**
 * Carga rápida de un turno.
 *
 * El objetivo declarado es que registrar horas lleve segundos: elegir a la
 * persona, tocar un atajo de duración y confirmar. La fecha viene puesta en hoy
 * y el motivo se recuerda del turno anterior, porque casi siempre se repite.
 */
export function QuickEntry({
  staff,
  weekId,
  weekStart,
  weekEnd,
  today,
}: {
  readonly staff: readonly StaffOption[];
  readonly weekId: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly today: string;
}) {
  const [minutes, setMinutes] = useState(60);
  const [manual, setManual] = useState("");
  const [staffId, setStaffId] = useState("");
  const [reason, setReason] = useState("");

  // La fecha por defecto es hoy, salvo que hoy caiga fuera del período.
  const defaultDate = useMemo(() => {
    if (today < weekStart) return weekStart;
    if (today > weekEnd) return weekEnd;
    return today;
  }, [today, weekStart, weekEnd]);

  const applyManual = (raw: string) => {
    setManual(raw);
    const parsed = parseDurationInput(raw);
    if (parsed !== null && parsed > 0) setMinutes(parsed);
  };

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const isHigh = minutes > SUSPICIOUS_MINUTES_PER_ENTRY;

  return (
    <ActionForm
      action={createHourEntryAction}
      resetOnSuccess={false}
      onSuccess={() => {
        setStaffId("");
        setMinutes(60);
        setManual("");
      }}
      className="flex flex-col gap-4 p-4"
    >
      {({ fieldError }) => (
        <>
          <input type="hidden" name="weekId" value={weekId} />
          <input type="hidden" name="hours" value={hours} />
          <input type="hidden" name="minutes" value={remainder} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Miembro"
              name="staffMemberId"
              required
              error={fieldError("staffMemberId")}
            >
              <Select
                id="staffMemberId"
                name="staffMemberId"
                value={staffId}
                onChange={(event) => setStaffId(event.target.value)}
                required
              >
                <option value="">Elegí un miembro…</option>
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} — {member.rank}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Fecha del turno"
              name="workDate"
              required
              error={fieldError("workDate")}
              hint={"Entre " + weekStart + " y " + weekEnd}
            >
              <Input
                id="workDate"
                name="workDate"
                type="date"
                defaultValue={defaultDate}
                min={weekStart}
                max={weekEnd}
                required
              />
            </Field>
          </div>

          <div>
            <span className="label">Duración</span>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setMinutes(preset);
                    setManual("");
                  }}
                  aria-pressed={minutes === preset}
                  className={cn(
                    "h-8 rounded-lg border px-3 text-xs font-semibold transition active:scale-95",
                    minutes === preset
                      ? "border-imperial-500/60 bg-imperial-500/15 text-imperial-300"
                      : "text-chalk-400 hover:text-chalk-200 border-white/10 hover:border-white/20",
                  )}
                >
                  {formatMinutes(preset)}
                </button>
              ))}
              <input
                value={manual}
                onChange={(event) => applyManual(event.target.value)}
                placeholder="2h 30m"
                aria-label="Duración personalizada"
                inputMode="text"
                className="field h-8 w-24 py-0 text-xs"
              />
            </div>

            <div className="mt-2 flex items-center gap-2">
              <span
                className={cn(
                  "tnum rounded-md border px-2 py-1 text-sm font-bold",
                  isHigh
                    ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                    : "text-chalk-100 border-white/10 bg-white/[0.04]",
                )}
              >
                {formatMinutes(minutes)}
              </span>
              <span className="text-chalk-600 text-[0.6875rem]">= {minutes} minutos exactos</span>
            </div>

            {isHigh ? (
              <p className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-amber-400">
                <Icon name="alert" size={13} />
                Es un turno muy largo. Confirmá que sea correcto antes de guardar.
              </p>
            ) : null}
            {fieldError("hours") ? (
              <p className="text-imperial-400 mt-1.5 text-xs">{fieldError("hours")?.join(" ")}</p>
            ) : null}
          </div>

          <Field
            label="Qué hizo"
            name="reason"
            required
            error={fieldError("reason")}
            hint="Queda visible en el detalle y en la auditoría."
          >
            <Textarea
              id="reason"
              name="reason"
              rows={2}
              required
              minLength={3}
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Turno noche, moderación general, soporte en tickets…"
            />
          </Field>

          <SubmitButton pendingLabel="Registrando…" className="w-full sm:w-auto sm:self-end">
            <Icon name="plus" size={15} />
            Registrar turno
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
