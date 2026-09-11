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
/* Estado semanal                                                             */
/* -------------------------------------------------------------------------- */

export const WEEKLY_STATUSES = ["normal", "inactivo", "justificado", "anulado"] as const;
export type WeeklyStatus = (typeof WEEKLY_STATUSES)[number];

export interface WeeklyStatusDefinition {
  readonly status: WeeklyStatus;
  readonly label: string;
  readonly short: string;
  readonly description: string;
  /** Si sus horas suman al total y al importe del período. */
  readonly counts: boolean;
  readonly dot: string;
  readonly rowTint: string;
  readonly badge: string;
}

export const WEEKLY_STATUS_DEFINITIONS: Readonly<Record<WeeklyStatus, WeeklyStatusDefinition>> = {
  normal: {
    status: "normal",
    label: "Normal · muestra horas",
    short: "Normal",
    description: "Trabaja con normalidad. Sus horas cuentan y se le paga.",
    counts: true,
    dot: "bg-chalk-500",
    rowTint: "",
    badge: "",
  },
  inactivo: {
    status: "inactivo",
    label: "Inactivo",
    short: "Inactivo",
    description: "No estuvo activo este período. Sus horas no cuentan ni se pagan.",
    counts: false,
    dot: "bg-imperial-500",
    rowTint: "bg-imperial-500/[0.06]",
    badge: "border-imperial-500/40 bg-imperial-500/12 text-imperial-300",
  },
  justificado: {
    status: "justificado",
    label: "Inactividad justificada",
    short: "Justificada",
    description: "Ausencia avisada y aceptada. No se le descuenta ni se le paga.",
    counts: false,
    dot: "bg-amber-400",
    rowTint: "bg-amber-400/[0.06]",
    badge: "border-amber-400/40 bg-amber-400/12 text-amber-300",
  },
  anulado: {
    status: "anulado",
    label: "Anulado",
    short: "Anulado",
    description: "El período de esta persona queda sin efecto. No suma ni se paga.",
    counts: false,
    dot: "bg-fuchsia-500",
    rowTint: "bg-fuchsia-500/[0.06]",
    badge: "border-fuchsia-500/40 bg-fuchsia-500/12 text-fuchsia-300",
  },
};

export const WEEKLY_STATUS_LIST: readonly WeeklyStatusDefinition[] =
  Object.values(WEEKLY_STATUS_DEFINITIONS);

export function isWeeklyStatus(value: unknown): value is WeeklyStatus {
  return typeof value === "string" && (WEEKLY_STATUSES as readonly string[]).includes(value);
}

/**
 * Si un estado hace que la persona entre en la liquidación.
 *
 * Es la regla que decide qué se paga, así que vive acá y no repartida por las
 * pantallas: sólo `normal` cobra.
 */
export function statusCounts(status: string): boolean {
  return WEEKLY_STATUS_DEFINITIONS[status as WeeklyStatus]?.counts ?? true;
}

export function statusLabel(status: string): string {
  return WEEKLY_STATUS_DEFINITIONS[status as WeeklyStatus]?.short ?? status;
}
