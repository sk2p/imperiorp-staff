import clsx, { type ClassValue } from "clsx";
import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/* -------------------------------------------------------------------------- */
/* Botón                                                                      */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success" | "outline";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

const BUTTON_BASE =
  "btn inline-flex items-center justify-center gap-2 rounded-[11px] font-semibold " +
  "whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-45 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-imperial-500";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "btn-primary text-white",
  success: "btn-success text-ink-950",
  secondary:
    "btn-quiet bg-ink-800 text-chalk-50 border border-white/10 hover:bg-ink-700 hover:border-white/20",
  outline:
    "btn-quiet bg-transparent text-chalk-200 border border-white/12 hover:bg-white/[0.05] hover:text-white hover:border-white/25",
  ghost: "btn-quiet bg-transparent text-chalk-400 hover:bg-white/[0.06] hover:text-white",
  danger:
    "btn-quiet bg-transparent text-imperial-400 border border-imperial-500/35 hover:bg-imperial-500/12 hover:border-imperial-500/60 hover:text-imperial-300",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-6 text-[0.9375rem]",
  icon: "h-9 w-9 p-0",
};

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({ variant, size, className, ...props }: ButtonProps) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

interface LinkButtonProps extends ComponentPropsWithoutRef<typeof Link> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function LinkButton({ variant, size, className, ...props }: LinkButtonProps) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Superficies                                                                */
/* -------------------------------------------------------------------------- */

export function Card({ className, children, ...props }: ComponentPropsWithoutRef<"section">) {
  return (
    <section className={cn("surface-edge", className)} {...props}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3.5 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-chalk-50 truncate text-sm font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="text-chalk-500 mt-0.5 text-xs leading-relaxed">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

export type BadgeTone = "neutral" | "imperial" | "jade" | "amber" | "sky" | "muted";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-white/[0.06] text-chalk-200 border-white/12",
  imperial: "bg-imperial-500/12 text-imperial-400 border-imperial-500/30",
  jade: "bg-jade-500/12 text-jade-400 border-jade-500/30",
  amber: "bg-amber-400/12 text-amber-400 border-amber-400/30",
  sky: "bg-sky-400/12 text-sky-400 border-sky-400/30",
  muted: "bg-white/[0.03] text-chalk-500 border-white/[0.08]",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  dot = false,
}: {
  readonly tone?: BadgeTone;
  readonly className?: string;
  readonly children: ReactNode;
  readonly dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Métrica                                                                    */
/* -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  hint,
  trend,
  accent = false,
  icon,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly trend?: { readonly value: number; readonly label: string };
  readonly accent?: boolean;
  readonly icon?: ReactNode;
}) {
  const direction = trend ? (trend.value > 0 ? "up" : trend.value < 0 ? "down" : "flat") : null;

  return (
    <div className={cn("surface-edge p-4", accent && "border-imperial-500/25")}>
      <div className="flex items-start justify-between gap-2">
        <p className="overline">{label}</p>
        {icon ? <span className="text-chalk-600">{icon}</span> : null}
      </div>
      <p
        className={cn(
          "tnum mt-2 text-[1.6rem] leading-none font-semibold tracking-tight",
          accent ? "text-imperial-400 stat-glow" : "text-chalk-50",
        )}
      >
        {value}
      </p>
      {hint ? <p className="text-chalk-500 mt-1.5 text-xs">{hint}</p> : null}
      {trend && direction ? (
        <p
          className={cn(
            "mt-1.5 flex items-center gap-1 text-xs font-medium",
            direction === "up" && "text-jade-400",
            direction === "down" && "text-imperial-400",
            direction === "flat" && "text-chalk-500",
          )}
        >
          <span aria-hidden>{direction === "up" ? "▲" : direction === "down" ? "▼" : "—"}</span>
          {trend.label}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Estados                                                                    */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}) {
  return (
    <div className="hatch anim-fade flex flex-col items-center justify-center gap-3 rounded-xl px-6 py-14 text-center">
      {icon ? (
        <div className="bg-ink-850 text-chalk-500 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10">
          {icon}
        </div>
      ) : null}
      <div>
        <p className="text-chalk-200 text-sm font-semibold">{title}</p>
        {description ? (
          <p className="text-chalk-500 mx-auto mt-1 max-w-sm text-xs leading-relaxed">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { readonly className?: string }) {
  return <div className={cn("skeleton h-4 w-full", className)} />;
}

/* -------------------------------------------------------------------------- */
/* Aviso                                                                      */
/* -------------------------------------------------------------------------- */

export function Callout({
  tone = "neutral",
  title,
  children,
}: {
  readonly tone?: "neutral" | "warning" | "danger" | "success";
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const tones = {
    neutral: "border-white/12 bg-white/[0.03] text-chalk-300",
    warning: "border-amber-400/30 bg-amber-400/[0.07] text-amber-200",
    danger: "border-imperial-500/35 bg-imperial-500/[0.07] text-imperial-200",
    success: "border-jade-500/30 bg-jade-500/[0.07] text-jade-200",
  } as const;

  return (
    <div className={cn("rounded-xl border px-3.5 py-3 text-xs leading-relaxed", tones[tone])}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      <div className="text-current/85">{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Encabezado de página                                                       */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="anim-rise flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1.5 overline">{eyebrow}</p> : null}
        <h1 className="text-chalk-50 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description ? (
          <p className="text-chalk-500 mt-1.5 max-w-2xl text-sm leading-relaxed">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* Campos de formulario                                                       */
/* -------------------------------------------------------------------------- */

export function Field({
  label,
  name,
  hint,
  error,
  required,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly hint?: string;
  readonly error?: readonly string[] | undefined;
  readonly required?: boolean;
  readonly children: ReactNode;
}) {
  const hasError = Boolean(error && error.length > 0);

  return (
    <div>
      <label className="label" htmlFor={name}>
        {label}
        {required ? <span className="text-imperial-500 ml-1">*</span> : null}
      </label>
      {children}
      {hasError ? (
        <p className="anim-fade text-imperial-400 mt-1.5 text-xs font-medium" role="alert">
          {error?.join(" ")}
        </p>
      ) : hint ? (
        <p className="text-chalk-600 mt-1.5 text-xs">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentPropsWithoutRef<"input">) {
  return <input className={cn("field", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea className={cn("field resize-y", className)} rows={3} {...props} />;
}

export function Select({ className, children, ...props }: ComponentPropsWithoutRef<"select">) {
  return (
    <select className={cn("field", className)} {...props}>
      {children}
    </select>
  );
}
