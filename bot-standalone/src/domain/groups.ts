import type { StaffCategory, StaffRank } from "./ranks";
import { categoryForRank } from "./ranks";

/**
 * IMPERIO RP — Agrupación de la planilla.
 *
 * La grilla de horas se lee por bloques, no como una lista plana de 40
 * personas: HIGH, MID y LOW. El grupo se deriva del rango, nunca se guarda ni
 * se acepta del cliente, así que no puede quedar desincronizado.
 */

export const STAFF_GROUPS = ["HIGH_STAFF", "MID_STAFF", "LOW_STAFF"] as const;
export type StaffGroup = (typeof STAFF_GROUPS)[number];

const GROUP_BY_CATEGORY: Readonly<Record<StaffCategory, StaffGroup>> = {
  DIRECCION: "HIGH_STAFF",
  ADMINISTRACION: "HIGH_STAFF",
  MODERACION: "MID_STAFF",
  SOPORTE: "LOW_STAFF",
};

export interface GroupDefinition {
  readonly group: StaffGroup;
  readonly label: string;
  /** Orden de aparición: primero el de mayor jerarquía. */
  readonly order: number;
  /** Color del encabezado y del filo de la sección. */
  readonly accent: string;
  readonly dot: string;
}

export const GROUP_DEFINITIONS: Readonly<Record<StaffGroup, GroupDefinition>> = {
  HIGH_STAFF: {
    group: "HIGH_STAFF",
    label: "High Staff",
    order: 1,
    accent: "text-imperial-400",
    dot: "bg-imperial-500",
  },
  MID_STAFF: {
    group: "MID_STAFF",
    label: "Mid Staff",
    order: 2,
    accent: "text-jade-400",
    dot: "bg-jade-500",
  },
  LOW_STAFF: {
    group: "LOW_STAFF",
    label: "Low Staff",
    order: 3,
    accent: "text-sky-400",
    dot: "bg-sky-400",
  },
};

export const GROUP_LIST: readonly GroupDefinition[] = Object.values(GROUP_DEFINITIONS).sort(
  (a, b) => a.order - b.order,
);

export function groupForCategory(category: string): StaffGroup {
  return GROUP_BY_CATEGORY[category as StaffCategory] ?? "LOW_STAFF";
}

export function groupForRank(rank: string): StaffGroup {
  return groupForCategory(categoryForRank(rank as StaffRank));
}

export function isStaffGroup(value: unknown): value is StaffGroup {
  return typeof value === "string" && (STAFF_GROUPS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Estado del día                                                             */
/* -------------------------------------------------------------------------- */

export const DAY_STATUSES = [
  "normal",
  "inactivo",
  "justificado",
  "anulado",
  "no_ingresado",
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export interface DayStatusDefinition {
  readonly status: DayStatus;
  readonly label: string;
  readonly short: string;
  readonly description: string;
  /** Si sus horas suman al total y al importe del período. */
  readonly counts: boolean;
  readonly dot: string;
  /** Estilo de la CASILLA del día marcado. La fila no se tiñe entera. */
  readonly cellTint: string;
  readonly badge: string;
}

export const DAY_STATUS_DEFINITIONS: Readonly<Record<DayStatus, DayStatusDefinition>> = {
  normal: {
    status: "normal",
    label: "Normal · cuenta las horas",
    short: "Normal",
    description: "Día normal. Las horas cuentan y se pagan.",
    counts: true,
    dot: "bg-chalk-500",
    cellTint: "",
    badge: "",
  },
  inactivo: {
    status: "inactivo",
    label: "Inactivo",
    short: "Inactivo",
    description: "Ese día no estuvo activo. No suma horas ni se paga.",
    counts: false,
    dot: "bg-imperial-500",
    cellTint: "border-imperial-500/45 bg-imperial-500/15 text-imperial-300",
    badge: "border-imperial-500/40 bg-imperial-500/12 text-imperial-300",
  },
  justificado: {
    status: "justificado",
    label: "Inactividad justificada",
    short: "Justificada",
    description: "Ausencia avisada y aceptada. Ese día no suma ni se paga.",
    counts: false,
    dot: "bg-amber-400",
    cellTint: "border-amber-400/45 bg-amber-400/15 text-amber-300",
    badge: "border-amber-400/40 bg-amber-400/12 text-amber-300",
  },
  /**
   * Días anteriores al ingreso de la persona al staff.
   *
   * No es lo mismo que "inactivo": no faltó, todavía no estaba. Se marca solo
   * al incorporar a alguien a un período ya empezado, y sirve para que su
   * primera semana no parezca la de alguien que no trabajó.
   */
  no_ingresado: {
    status: "no_ingresado",
    label: "Todavía no estaba",
    short: "No estaba",
    description: "Se incorporó al staff después de este día.",
    counts: false,
    dot: "bg-chalk-600",
    cellTint: "border-white/[0.06] bg-white/[0.02] text-chalk-700",
    badge: "border-white/12 bg-white/[0.04] text-chalk-500",
  },
  anulado: {
    status: "anulado",
    label: "Anulado",
    short: "Anulado",
    description: "Ese día queda sin efecto. No suma ni se paga.",
    counts: false,
    dot: "bg-fuchsia-500",
    cellTint: "border-fuchsia-500/45 bg-fuchsia-500/15 text-fuchsia-300",
    badge: "border-fuchsia-500/40 bg-fuchsia-500/12 text-fuchsia-300",
  },
};

export const DAY_STATUS_LIST: readonly DayStatusDefinition[] =
  Object.values(DAY_STATUS_DEFINITIONS);

export function isDayStatus(value: unknown): value is DayStatus {
  return typeof value === "string" && (DAY_STATUSES as readonly string[]).includes(value);
}

/**
 * Si un día entra en la liquidación.
 *
 * Es la regla que decide qué se paga, así que vive acá y no repartida por las
 * pantallas: sólo `normal` cuenta.
 */
export function statusCounts(status: string): boolean {
  return DAY_STATUS_DEFINITIONS[status as DayStatus]?.counts ?? true;
}

export function statusLabel(status: string): string {
  return DAY_STATUS_DEFINITIONS[status as DayStatus]?.short ?? status;
}

/* -------------------------------------------------------------------------- */
/* Colores por rango                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Color por defecto de cada rango, editable desde Configuración.
 *
 * La familia se reconoce por el tono —violetas la dirección y administración,
 * verdes la moderación, azules el soporte— y dentro de cada una el color se
 * aclara al bajar de rango, de modo que la jerarquía se lee sin tener que
 * descifrar las siglas.
 */
export const DEFAULT_RANK_COLORS: Readonly<Record<string, string>> = {
  DG: "#c026d3",
  SUBDG: "#a855f7",
  "ADM++": "#8b5cf6",
  "ADM+": "#7c3aed",
  ADM: "#ec4899",
  "MOD++": "#22c55e",
  "MOD+": "#4ade80",
  MOD: "#86efac",
  SE: "#6366f1",
  SP: "#38bdf8",
  SDP: "#7dd3fc",
};

/** Un hex `#rrggbb` válido. Se valida antes de guardarlo y antes de pintarlo. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Decide si el texto sobre un color debe ser claro u oscuro.
 *
 * Usa la luminancia relativa en vez de un promedio simple: el ojo percibe el
 * verde mucho más brillante que el azul, y un promedio deja texto ilegible
 * sobre los verdes de moderación.
 */
export function readableTextOn(hex: string): "#0b0d10" | "#ffffff" {
  if (!isHexColor(hex)) return "#ffffff";
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return luminance > 0.45 ? "#0b0d10" : "#ffffff";
}
