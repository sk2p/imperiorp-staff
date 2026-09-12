"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";

import { Icon } from "@/components/layout/icons";
import { cn } from "./primitives";

/**
 * Filtros que viven en la URL.
 *
 * Se eligió la barra de direcciones como estado en lugar de `useState` porque
 * así un filtro se puede compartir por mensaje, se conserva al recargar y
 * funciona con el botón "atrás" del navegador. Además, la consulta se resuelve
 * en el servidor: el navegador nunca recibe filas que el filtro descartaba.
 */

function useQueryUpdater() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = useCallback(
    (changes: Record<string, string | null>, options: { resetPage?: boolean } = {}) => {
      const params = new URLSearchParams(searchParams.toString());

      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }

      // Cambiar un filtro con la página 7 abierta mostraría un listado vacío.
      if (options.resetPage !== false) params.delete("page");

      startTransition(() => {
        router.replace(pathname + (params.size > 0 ? "?" + params.toString() : ""), {
          scroll: false,
        });
      });
    },
    [router, pathname, searchParams],
  );

  return { update, pending, searchParams };
}

export function SearchField({
  placeholder = "Buscar…",
  paramName = "search",
}: {
  readonly placeholder?: string;
  readonly paramName?: string;
}) {
  const { update, pending, searchParams } = useQueryUpdater();
  const [value, setValue] = useState(searchParams.get(paramName) ?? "");

  // Se espera a que la persona deje de tipear antes de consultar al servidor.
  useEffect(() => {
    const current = searchParams.get(paramName) ?? "";
    if (value === current) return;

    const timer = setTimeout(() => update({ [paramName]: value || null }), 320);
    return () => clearTimeout(timer);
  }, [value, paramName, searchParams, update]);

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-xs">
      <span className="text-chalk-600 pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center">
        <Icon name="search" size={15} />
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="field h-9 py-0 pl-9"
      />
      {pending ? (
        <span className="absolute inset-y-0 right-2.5 flex items-center">
          <span className="loader-dots text-chalk-600" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        </span>
      ) : null}
    </div>
  );
}

export function FilterSelect({
  paramName,
  label,
  options,
  allLabel = "Todos",
}: {
  readonly paramName: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly allLabel?: string;
}) {
  const { update, searchParams } = useQueryUpdater();
  const current = searchParams.get(paramName) ?? "";

  return (
    <select
      aria-label={label}
      value={current}
      onChange={(event) => update({ [paramName]: event.target.value || null })}
      className={cn("field h-9 w-auto py-0 text-xs", current && "border-imperial-500/45")}
    >
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Selector de período. Es el contexto de casi todas las pantallas. */
export function WeekSelector({
  weeks,
  paramName = "periodo",
  currentId,
}: {
  readonly weeks: readonly {
    readonly id: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly status: string;
    readonly label: string | null;
  }[];
  readonly paramName?: string;
  readonly currentId: string | null;
}) {
  const { update } = useQueryUpdater();

  if (weeks.length === 0) return null;

  return (
    <select
      aria-label="Período"
      value={currentId ?? ""}
      onChange={(event) => update({ [paramName]: event.target.value || null })}
      className="field h-9 w-auto max-w-[16rem] py-0 text-xs font-medium"
    >
      {weeks.map((week) => {
        const [, startMonth, startDay] = week.startDate.split("-");
        const [, endMonth, endDay] = week.endDate.split("-");
        return (
          <option key={week.id} value={week.id}>
            {startDay + "/" + startMonth + " → " + endDay + "/" + endMonth}
            {week.status === "open" ? "  ·  abierto" : ""}
            {week.label ? "  ·  " + week.label : ""}
          </option>
        );
      })}
    </select>
  );
}

export function Pagination({
  page,
  pageCount,
  total,
  itemLabel = "registros",
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly itemLabel?: string;
}) {
  const { update, pending } = useQueryUpdater();

  if (pageCount <= 1) {
    return (
      <p className="text-chalk-600 px-4 py-3 text-xs">
        {total.toLocaleString("es-AR")} {itemLabel}
      </p>
    );
  }

  const go = (target: number) =>
    update({ page: target === 1 ? null : String(target) }, { resetPage: false });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.05] px-4 py-3">
      <p className="text-chalk-600 text-xs">
        {total.toLocaleString("es-AR")} {itemLabel} · página {page} de {pageCount}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => go(page - 1)}
          disabled={page <= 1 || pending}
          className="text-chalk-300 h-8 rounded-lg border border-white/10 px-3 text-xs font-semibold transition hover:bg-white/[0.05] disabled:opacity-35"
        >
          Anterior
        </button>
        <button
          type="button"
          onClick={() => go(page + 1)}
          disabled={page >= pageCount || pending}
          className="text-chalk-300 h-8 rounded-lg border border-white/10 px-3 text-xs font-semibold transition hover:bg-white/[0.05] disabled:opacity-35"
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}

export function FilterBar({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
      {children}
    </div>
  );
}
