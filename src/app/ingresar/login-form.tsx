"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/layout/icons";
import { SubmitButton } from "@/components/ui/interactive";
import { Field, Input } from "@/components/ui/primitives";
import { loginAction } from "@/server/actions";
import type { ActionState } from "@/server/actions/helpers";

/**
 * Formulario de acceso.
 *
 * No lleva token anti-CSRF porque todavía no hay sesión de la cual derivarlo.
 * La protección acá la da la validación de origen de las Server Actions de
 * Next.js, más el límite de intentos del servidor.
 */
export function LoginForm({ redirectTo }: { readonly redirectTo: string | null }) {
  const [state, formAction] = useActionState<ActionState<unknown>, FormData>(loginAction, {
    status: "idle",
  });
  const [showPassword, setShowPassword] = useState(false);

  const error = state.status === "error" ? state : null;

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {redirectTo ? <input type="hidden" name="redirectTo" value={redirectTo} /> : null}

      {error ? (
        <div
          role="alert"
          className={
            "anim-fade flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-relaxed " +
            (error.code === "RATE_LIMITED"
              ? "border-amber-400/35 bg-amber-400/[0.08] text-amber-200"
              : "border-imperial-500/35 bg-imperial-500/[0.08] text-imperial-200")
          }
        >
          <Icon name={error.code === "RATE_LIMITED" ? "lock" : "alert"} size={15} />
          <span>{error.message}</span>
        </div>
      ) : null}

      <Field label="Usuario" name="username" required>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          maxLength={32}
          placeholder="tu usuario"
        />
      </Field>

      <Field label="Contraseña" name="password" required>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            maxLength={200}
            placeholder="••••••••••"
            className="pr-11"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
            className="text-chalk-600 hover:text-chalk-300 absolute inset-y-0 right-0 flex w-10 items-center justify-center transition"
          >
            {showPassword ? (
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path
                  d="M3 3l14 14M8.2 8.4a2.4 2.4 0 0 0 3.3 3.4M6.1 6.2C4.5 7.2 3.2 8.6 2.5 10c1.4 2.8 4.2 5 7.5 5 1.3 0 2.5-.3 3.6-.9M16 12.6c.7-.7 1.2-1.6 1.5-2.6-1.4-2.8-4.2-5-7.5-5-.6 0-1.1.1-1.6.2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
                <path
                  d="M2.5 10c1.4-2.8 4.2-5 7.5-5s6.1 2.2 7.5 5c-1.4 2.8-4.2 5-7.5 5s-6.1-2.2-7.5-5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            )}
          </button>
        </div>
      </Field>

      <SubmitButton size="lg" pendingLabel="Verificando…" className="mt-1 w-full">
        Ingresar
      </SubmitButton>
    </form>
  );
}
