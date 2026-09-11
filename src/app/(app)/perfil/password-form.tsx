"use client";

import { useState } from "react";

import { ActionForm, SubmitButton } from "@/components/ui/interactive";
import { Field, Input } from "@/components/ui/primitives";
import { changePasswordAction } from "@/server/actions";

const STRENGTH_COLORS = [
  "bg-imperial-500",
  "bg-imperial-500",
  "bg-amber-400",
  "bg-jade-500",
  "bg-jade-400",
] as const;

const STRENGTH_LABELS = ["Muy débil", "Débil", "Aceptable", "Fuerte", "Muy fuerte"] as const;

/**
 * Indicador visual, nada más. Las reglas que deciden si la contraseña se acepta
 * viven en el servidor (`evaluatePassword`): esto sólo da una pista mientras se
 * escribe, y no puede saltearse ninguna validación.
 */
function measure(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string; hint: string } {
  const problems: string[] = [];
  if (password.length < 10) problems.push("Necesita al menos 10 caracteres.");
  if (!/[a-z]/.test(password)) problems.push("Falta una minúscula.");
  if (!/[A-Z]/.test(password)) problems.push("Falta una mayúscula.");
  if (!/\d/.test(password)) problems.push("Falta un número.");

  let score = 0;
  if (password.length >= 10) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) score += 1;
  if (/[^a-zA-Z0-9]/.test(password)) score += 1;

  const bounded = Math.min(4, problems.length > 0 ? Math.min(score, 1) : score) as
    0 | 1 | 2 | 3 | 4;
  return {
    score: bounded,
    label: STRENGTH_LABELS[bounded] ?? "Muy débil",
    hint: problems[0] ?? "",
  };
}

export function ChangePasswordForm() {
  const [password, setPassword] = useState("");
  const strength = password.length > 0 ? measure(password) : null;

  return (
    <ActionForm
      action={changePasswordAction}
      resetOnSuccess
      onSuccess={() => setPassword("")}
      className="flex flex-col gap-4 p-4"
    >
      {({ fieldError }) => (
        <>
          <Field
            label="Contraseña actual"
            name="currentPassword"
            required
            error={fieldError("currentPassword")}
          >
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>

          <Field
            label="Contraseña nueva"
            name="newPassword"
            required
            error={fieldError("newPassword")}
          >
            <Input
              id="newPassword"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {strength ? (
            <div>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((index) => (
                  <span
                    key={index}
                    className={
                      "h-1 flex-1 rounded-full transition-colors " +
                      (index <= strength.score
                        ? (STRENGTH_COLORS[strength.score] ?? "bg-chalk-600")
                        : "bg-white/[0.07]")
                    }
                  />
                ))}
              </div>
              <p className="text-chalk-500 mt-1.5 text-xs">
                Seguridad: <span className="text-chalk-300 font-semibold">{strength.label}</span>
                {strength.hint ? " · " + strength.hint : ""}
              </p>
            </div>
          ) : null}

          <Field
            label="Repetir contraseña nueva"
            name="confirmPassword"
            required
            error={fieldError("confirmPassword")}
          >
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </Field>

          <SubmitButton className="self-start">Cambiar contraseña</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
