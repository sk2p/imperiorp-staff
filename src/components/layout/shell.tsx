"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { roleLabel } from "@/domain/permissions";
import type { Viewer } from "@/lib/auth/context";
import { cn } from "@/components/ui/primitives";
import { Icon } from "./icons";
import { visibleItems, type NavItem } from "./navigation";

/**
 * Armazón de la aplicación.
 *
 * Escritorio: barra lateral fija con la identidad de Imperio RP.
 * Móvil: barra inferior con los cuatro accesos frecuentes y un cajón para el
 * resto. La decisión de fondo es que registrar horas desde el teléfono tenga
 * exactamente la misma cantidad de toques que desde la computadora.
 */

function isActiveHref(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 focus-visible:outline-offset-4">
      <Image
        src="/imperiorplogo.webp"
        alt="Imperio RP"
        width={34}
        height={34}
        priority
        className="shrink-0 drop-shadow-[0_2px_8px_rgb(229_22_44/0.45)]"
      />
      {!compact ? (
        <span className="min-w-0">
          <span className="text-chalk-50 block text-[0.8125rem] leading-tight font-bold tracking-[0.14em]">
            IMPERIO RP
          </span>
          <span className="text-chalk-600 block text-[0.625rem] leading-tight font-medium tracking-[0.16em] uppercase">
            Gestión de staff
          </span>
        </span>
      ) : null}
    </Link>
  );
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={cn(
        "row-rail group flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-sm font-medium transition-colors duration-150",
        active
          ? "text-chalk-50 bg-white/[0.055]"
          : "text-chalk-400 hover:text-chalk-200 hover:bg-white/[0.03]",
      )}
    >
      <Icon
        name={item.icon}
        size={17}
        className={cn(
          "shrink-0 transition-colors",
          active ? "text-imperial-400" : "text-chalk-600 group-hover:text-chalk-400",
        )}
      />
      {item.label}
    </Link>
  );
}

export function AppShell({
  viewer,
  children,
}: {
  readonly viewer: Viewer;
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const groups = visibleItems(viewer.permissions, viewer.role === "OWNER");
  const mobilePrimary = groups.flatMap((group) => group.items).filter((item) => item.primary);

  // El cajón se cierra al navegar: si quedara abierto taparía la página nueva.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Con el cajón abierto no se desplaza el fondo.
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  const navigation = (onNavigate?: () => void) => (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1.5 px-3 overline">{group.label}</p>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActiveHref(pathname, item.href)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  const accountPanel = (
    <div className="border-t border-white/[0.07] p-3">
      <div className="flex items-center gap-2.5 rounded-[10px] bg-white/[0.03] px-3 py-2.5">
        <span className="bg-ink-800 text-chalk-200 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/12 text-xs font-bold">
          {viewer.displayName.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-chalk-100 block truncate text-xs font-semibold">
            {viewer.displayName}
          </span>
          <span className="text-chalk-600 block truncate text-[0.6875rem]">
            {roleLabel(viewer.role)}
          </span>
        </span>
        <form action="/api/salir" method="post">
          <button
            type="submit"
            title="Cerrar sesión"
            aria-label="Cerrar sesión"
            className="text-chalk-600 hover:bg-imperial-500/12 hover:text-imperial-400 flex h-8 w-8 items-center justify-center rounded-lg transition"
          >
            <Icon name="logout" size={16} />
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Barra lateral — escritorio */}
      <aside className="bg-ink-900/80 fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-white/[0.07] backdrop-blur-xl lg:flex">
        <div className="flex h-14 items-center border-b border-white/[0.07] px-4">
          <Brand />
        </div>
        {navigation()}
        {accountPanel}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        {/* Barra superior — móvil */}
        <header className="bg-ink-950/85 sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-white/[0.07] px-4 backdrop-blur-xl lg:hidden">
          <Brand />
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Abrir menú"
            aria-expanded={drawerOpen}
            className="text-chalk-300 flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 transition active:scale-95"
          >
            <Icon name="menu" size={18} />
          </button>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 pt-5 pb-24 sm:px-6 lg:pb-10">
          {children}
        </main>
      </div>

      {/* Barra inferior — móvil */}
      <nav className="safe-bottom bg-ink-950/92 fixed inset-x-0 bottom-0 z-20 flex border-t border-white/[0.07] px-1 pt-1 backdrop-blur-xl lg:hidden">
        {mobilePrimary.map((item) => {
          const active = isActiveHref(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-[0.625rem] font-semibold transition active:scale-95",
                active ? "text-imperial-400" : "text-chalk-600",
              )}
            >
              <Icon name={item.icon} size={19} />
              {item.short}
            </Link>
          );
        })}
      </nav>

      {/* Cajón lateral — móvil */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setDrawerOpen(false)}
            className="anim-fade absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <div className="anim-rise bg-ink-900 absolute inset-y-0 right-0 flex w-72 max-w-[88vw] flex-col border-l border-white/10">
            <div className="flex h-14 items-center justify-between border-b border-white/[0.07] px-4">
              <Brand compact />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Cerrar menú"
                className="text-chalk-500 flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/[0.06]"
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
            </div>
            {navigation(() => setDrawerOpen(false))}
            {accountPanel}
          </div>
        </div>
      ) : null}
    </div>
  );
}
