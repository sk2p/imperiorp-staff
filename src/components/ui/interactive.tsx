"use client";

import {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";

import { CSRF_FIELD } from "@/lib/auth/csrf";
import type { ActionState } from "@/server/actions/helpers";
import { Button, buttonClass, cn, type ButtonSize, type ButtonVariant } from "./primitives";

/* -------------------------------------------------------------------------- */
/* Token anti-CSRF                                                            */
/* -------------------------------------------------------------------------- */

const CsrfContext = createContext<string>("");

export function CsrfProvider({
  token,
  children,
}: {
  readonly token: string;
  readonly children: ReactNode;
}) {
  return <CsrfContext.Provider value={token}>{children}</CsrfContext.Provider>;
}

/**
 * Token para componentes que invocan una Server Action sin formulario (la
 * planilla de horas guarda cada casilla por su cuenta). El servidor lo exige
 * igual que a cualquier formulario.
 */
export function useCsrfToken(): string {
  return useContext(CsrfContext);
}

/** Campo oculto que todo formulario incluye. El servidor lo exige siempre. */
export function CsrfField() {
  const token = useContext(CsrfContext);
  return <input type="hidden" name={CSRF_FIELD} value={token} />;
}

/* -------------------------------------------------------------------------- */
/* Avisos efímeros                                                            */
/* -------------------------------------------------------------------------- */

interface Toast {
  readonly id: number;
  readonly tone: "success" | "error";
  readonly message: string;
}

const ToastContext = createContext<(tone: Toast["tone"], message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((tone: Toast["tone"], message: string) => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current, { id, tone, message }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        className="safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-100 flex flex-col items-center gap-2 px-3 sm:bottom-4 sm:items-end sm:px-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "anim-pop pointer-events-auto w-full max-w-sm rounded-xl border px-4 py-3 text-sm shadow-[0_12px_40px_-12px_rgb(0_0_0/0.8)] backdrop-blur-md",
              toast.tone === "success"
                ? "border-jade-500/35 bg-jade-500/[0.12] text-jade-100"
                : "border-imperial-500/40 bg-imperial-500/[0.12] text-imperial-100",
            )}
          >
            <div className="flex items-start gap-2.5">
              <span aria-hidden className="mt-0.5 text-base leading-none">
                {toast.tone === "success" ? "✓" : "!"}
              </span>
              <p className="leading-relaxed">{toast.message}</p>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Formularios conectados a Server Actions                                    */
/* -------------------------------------------------------------------------- */

type ServerAction = (
  previous: ActionState<unknown>,
  formData: FormData,
) => Promise<ActionState<unknown>>;

export function SubmitButton({
  children,
  pendingLabel = "Guardando…",
  variant = "primary",
  size = "md",
  className,
  disabled,
}: {
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
  readonly disabled?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={buttonClass(variant, size, className)}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

export interface ActionFormRenderProps {
  readonly state: ActionState<unknown>;
  readonly fieldError: (name: string) => readonly string[] | undefined;
}

/**
 * Formulario estándar: agrega el token anti-CSRF, muestra los errores por campo
 * y avisa del resultado. La validación real ocurre en el servidor; esto sólo
 * presenta lo que el servidor respondió.
 */
export function ActionForm({
  action,
  children,
  className,
  onSuccess,
  resetOnSuccess = false,
  toastOnSuccess = true,
}: {
  readonly action: ServerAction;
  readonly children: (props: ActionFormRenderProps) => ReactNode;
  readonly className?: string;
  readonly onSuccess?: (state: ActionState<unknown>) => void;
  readonly resetOnSuccess?: boolean;
  readonly toastOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState<ActionState<unknown>, FormData>(action, {
    status: "idle",
  });
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const lastHandled = useRef<ActionState<unknown> | null>(null);

  useEffect(() => {
    if (state === lastHandled.current) return;
    lastHandled.current = state;

    if (state.status === "success") {
      if (toastOnSuccess) toast("success", state.message);
      if (resetOnSuccess) formRef.current?.reset();
      onSuccess?.(state);
    }
    if (state.status === "error" && state.code !== "VALIDATION") {
      toast("error", state.message);
    }
  }, [state, toast, onSuccess, resetOnSuccess, toastOnSuccess]);

  const fieldError = (name: string): readonly string[] | undefined =>
    state.status === "error" ? state.fieldErrors?.[name] : undefined;

  return (
    <form ref={formRef} action={formAction} className={className} noValidate>
      <CsrfField />
      {state.status === "error" && state.code === "VALIDATION" && state.fieldErrors?._form ? (
        <p className="anim-fade border-imperial-500/35 bg-imperial-500/[0.08] text-imperial-200 mb-3 rounded-lg border px-3 py-2 text-xs">
          {state.fieldErrors._form.join(" ")}
        </p>
      ) : null}
      {state.status === "error" && state.code !== "VALIDATION" ? (
        <p className="anim-fade border-imperial-500/35 bg-imperial-500/[0.08] text-imperial-200 mb-3 rounded-lg border px-3 py-2 text-xs">
          {state.message}
        </p>
      ) : null}
      {children({ state, fieldError })}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Diálogo                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Modal accesible construido sobre `<dialog>` nativo: trae gratis el foco
 * atrapado, el cierre con Escape y la capa superior del navegador.
 * En pantallas chicas entra desde abajo, como una hoja.
 */
export function Dialog({
  trigger,
  title,
  description,
  children,
  width = "md",
}: {
  readonly trigger: (open: () => void) => ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly children: (close: () => void) => ReactNode;
  readonly width?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  const titleId = useId();

  const open = useCallback(() => {
    setMounted(true);
    // Se espera al siguiente fotograma para que el contenido exista antes de abrir.
    requestAnimationFrame(() => ref.current?.showModal());
  }, []);

  const close = useCallback(() => {
    ref.current?.close();
  }, []);

  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-3xl" } as const;

  return (
    <>
      {trigger(open)}
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClose={() => setMounted(false)}
        onClick={(event) => {
          // Clic en el fondo (fuera del panel) cierra el diálogo.
          if (event.target === ref.current) close();
        }}
        className={cn(
          "text-chalk-50 m-0 w-full bg-transparent p-0 backdrop:bg-black/70 backdrop:backdrop-blur-sm",
          "max-h-dvh place-self-end sm:place-self-center",
          "sm:mx-auto sm:my-auto",
          widths[width],
        )}
      >
        {mounted ? (
          <div className="anim-slide-up bg-ink-900 sm:anim-pop flex max-h-[92dvh] flex-col overflow-hidden rounded-t-2xl border border-white/12 shadow-[0_-8px_60px_-12px_rgb(0_0_0/0.9)] sm:rounded-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-sm font-semibold tracking-tight">
                  {title}
                </h2>
                {description ? (
                  <p className="text-chalk-500 mt-1 text-xs leading-relaxed">{description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Cerrar"
                className="text-chalk-500 -mt-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/[0.06] hover:text-white"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
                  <path
                    d="M3.5 3.5 11.5 11.5M11.5 3.5 3.5 11.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </header>
            <div className="scroll-y flex-1 overflow-y-auto px-5 py-4">{children(close)}</div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}

/**
 * Confirmación para acciones destructivas. Exige escribir una palabra exacta:
 * imposible de disparar sin querer con un clic de más.
 */
export function ConfirmField({
  word,
  label,
  name = "confirmation",
  error,
}: {
  readonly word: string;
  readonly label?: string;
  readonly name?: string;
  readonly error?: readonly string[] | undefined;
}) {
  const [value, setValue] = useState("");
  const matches = value.trim().toUpperCase() === word;

  return (
    <div>
      <label className="label" htmlFor={name}>
        {label ?? "Escribí " + word + " para confirmar"}
      </label>
      <input
        id={name}
        name={name}
        value={value}
        onChange={(event) => setValue(event.target.value.toUpperCase())}
        autoComplete="off"
        spellCheck={false}
        placeholder={word}
        aria-invalid={error && error.length > 0 ? true : undefined}
        className={cn(
          "field tracking-[0.2em] uppercase",
          matches && "border-jade-500/60 text-jade-300",
        )}
      />
      {error && error.length > 0 ? (
        <p className="text-imperial-400 mt-1.5 text-xs">{error.join(" ")}</p>
      ) : null}
    </div>
  );
}

/** Clave de idempotencia generada una sola vez por formulario montado. */
export function IdempotencyField({ name = "idempotencyKey" }: { readonly name?: string }) {
  const [key] = useState(() => crypto.randomUUID().replace(/-/g, ""));
  return <input type="hidden" name={name} value={key} />;
}

export { Button };
