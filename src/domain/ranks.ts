import type { MoneyUnits } from "./money";

/**
 * IMPERIO RP — Rangos del staff.
 *
 * Un rango describe la posición de una persona DENTRO del servidor de rol.
 * No tiene ninguna relación con los permisos de acceso a este panel: eso lo
 * define el rol del usuario del sistema (ver `permissions.ts`).
 */

export const STAFF_CATEGORIES = ["SOPORTE", "MODERACION", "ADMINISTRACION", "DIRECCION"] as const;
export type StaffCategory = (typeof STAFF_CATEGORIES)[number];

export const STAFF_RANKS = [
  "SDP",
  "SP",
  "SE",
  "MOD",
  "MOD+",
  "MOD++",
  "ADM",
  "ADM+",
  "ADM++",
  "SUBDG",
  "DG",
] as const;
export type StaffRank = (typeof STAFF_RANKS)[number];

export interface RankDefinition {
  readonly rank: StaffRank;
  readonly name: string;
  readonly category: StaffCategory;
  /** Tarifa por defecto. La vigente se lee de `rank_rates` en base de datos. */
  readonly defaultRatePerHour: MoneyUnits;
  /** Orden jerárquico ascendente. Se usa para ordenar tablas y gráficos. */
  readonly tier: number;
}

export const RANK_DEFINITIONS: Readonly<Record<StaffRank, RankDefinition>> = {
  SDP: {
    rank: "SDP",
    name: "Soporte de Prueba",
    category: "SOPORTE",
    defaultRatePerHour: 1_000_000,
    tier: 1,
  },
  SP: { rank: "SP", name: "Soporte", category: "SOPORTE", defaultRatePerHour: 1_000_000, tier: 2 },
  SE: {
    rank: "SE",
    name: "Soporte Experimentado",
    category: "SOPORTE",
    defaultRatePerHour: 1_000_000,
    tier: 3,
  },
  MOD: {
    rank: "MOD",
    name: "Moderador",
    category: "MODERACION",
    defaultRatePerHour: 1_500_000,
    tier: 4,
  },
  "MOD+": {
    rank: "MOD+",
    name: "Moderador+",
    category: "MODERACION",
    defaultRatePerHour: 1_500_000,
    tier: 5,
  },
  "MOD++": {
    rank: "MOD++",
    name: "Moderador++",
    category: "MODERACION",
    defaultRatePerHour: 1_500_000,
    tier: 6,
  },
  ADM: {
    rank: "ADM",
    name: "Administrador",
    category: "ADMINISTRACION",
    defaultRatePerHour: 2_000_000,
    tier: 7,
  },
  "ADM+": {
    rank: "ADM+",
    name: "Administrador+",
    category: "ADMINISTRACION",
    defaultRatePerHour: 2_000_000,
    tier: 8,
  },
  "ADM++": {
    rank: "ADM++",
    name: "Administrador++",
    category: "ADMINISTRACION",
    defaultRatePerHour: 2_000_000,
    tier: 9,
  },
  SUBDG: {
    rank: "SUBDG",
    name: "Subdirector General",
    category: "DIRECCION",
    defaultRatePerHour: 2_000_000,
    tier: 10,
  },
  DG: {
    rank: "DG",
    name: "Director General",
    category: "DIRECCION",
    defaultRatePerHour: 2_000_000,
    tier: 11,
  },
};

export const RANK_LIST: readonly RankDefinition[] = Object.values(RANK_DEFINITIONS).sort(
  (a, b) => a.tier - b.tier,
);

export const CATEGORY_LABELS: Readonly<Record<StaffCategory, string>> = {
  SOPORTE: "Soporte",
  MODERACION: "Moderación",
  ADMINISTRACION: "Administración",
  DIRECCION: "Dirección",
};

/** Identidad visual por categoría. Un color por familia, no por rango. */
export const CATEGORY_ACCENT: Readonly<
  Record<StaffCategory, { readonly fg: string; readonly bg: string; readonly border: string }>
> = {
  SOPORTE: {
    fg: "text-sky-300",
    bg: "bg-sky-500/10",
    border: "border-sky-400/25",
  },
  MODERACION: {
    fg: "text-amber-300",
    bg: "bg-amber-500/10",
    border: "border-amber-400/25",
  },
  ADMINISTRACION: {
    fg: "text-rose-300",
    bg: "bg-rose-500/10",
    border: "border-rose-400/25",
  },
  DIRECCION: {
    fg: "text-violet-300",
    bg: "bg-violet-500/10",
    border: "border-violet-400/25",
  },
};

export function isStaffRank(value: unknown): value is StaffRank {
  return typeof value === "string" && (STAFF_RANKS as readonly string[]).includes(value);
}

export function isStaffCategory(value: unknown): value is StaffCategory {
  return typeof value === "string" && (STAFF_CATEGORIES as readonly string[]).includes(value);
}

export function getRank(rank: string): RankDefinition | undefined {
  return isStaffRank(rank) ? RANK_DEFINITIONS[rank] : undefined;
}

/**
 * Categoría de un rango. Nunca se confía en la categoría que llega del cliente:
 * siempre se deriva acá, del rango validado.
 */
export function categoryForRank(rank: StaffRank): StaffCategory {
  return RANK_DEFINITIONS[rank].category;
}

export function rankTier(rank: string): number {
  return getRank(rank)?.tier ?? 0;
}

export function rankLabel(rank: string): string {
  return getRank(rank)?.name ?? rank;
}

/** Devuelve "ascenso", "descenso" o "lateral" al comparar dos rangos. */
export function compareRankChange(from: string, to: string): "ascenso" | "descenso" | "lateral" {
  const delta = rankTier(to) - rankTier(from);
  if (delta > 0) return "ascenso";
  if (delta < 0) return "descenso";
  return "lateral";
}

/**
 * Posición inicial de un rango dentro de la lista.
 *
 * La grilla ordena por el orden manual que fija el equipo arrastrando filas.
 * Para que la lista aparezca ordenada por jerarquía antes de que nadie toque
 * nada, cada rango arranca en su propio escalón: DG en 100, SUBDG en 200, y así
 * hasta SDP. Los cien de separación dejan lugar para acomodar gente entre medio
 * sin tener que renumerar a todos.
 */
export function rankBaseOrder(rank: string): number {
  const definition = isStaffRank(rank) ? RANK_DEFINITIONS[rank] : undefined;
  return definition ? (12 - definition.tier) * 100 : 1200;
}
