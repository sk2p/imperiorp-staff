import { z } from "zod";

import { MAX_MONEY_UNITS } from "@/domain/money";
import { STAFF_RANKS } from "@/domain/ranks";
import {
  calendarDateSchema,
  optionalText,
  paginationSchema,
  reasonSchema,
  searchTermSchema,
  sortDirectionSchema,
  uuidSchema,
} from "./common";

/** Contratos para tarifas, configuración, auditoría, exportación e importación. */

/* -------------------------------------------------------------------------- */
/* Tarifas por rango                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cambiar una tarifa afecta únicamente a los períodos ABIERTOS. Los cerrados
 * conservan la tarifa congelada en su snapshot: una liquidación de hace un año
 * no puede cambiar de importe porque hoy se ajustó un sueldo.
 */
export const updateRankRateSchema = z.object({
  rank: z.enum(STAFF_RANKS),
  ratePerHour: z.coerce
    .number()
    .int("La tarifa debe ser un número entero.")
    .positive("La tarifa tiene que ser mayor a cero.")
    .max(MAX_MONEY_UNITS, "La tarifa supera el máximo admitido."),
  reason: reasonSchema,
});

export type UpdateRankRateInput = z.infer<typeof updateRankRateSchema>;

/* -------------------------------------------------------------------------- */
/* Configuración general                                                      */
/* -------------------------------------------------------------------------- */

export const SETTING_KEYS = [
  "organization.name",
  "organization.timezone",
  "organization.currency_symbol",
  "payroll.default_period_days",
  "payroll.require_payment_reference",
  "security.session_idle_hours",
  "ui.show_demo_banner",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export const updateSettingSchema = z.object({
  key: z.enum(SETTING_KEYS, { message: "Clave de configuración desconocida." }),
  value: z.string().max(500, "El valor no puede superar los 500 caracteres."),
});

export type UpdateSettingInput = z.infer<typeof updateSettingSchema>;

/* -------------------------------------------------------------------------- */
/* Auditoría e historial                                                      */
/* -------------------------------------------------------------------------- */

export const AUDIT_ACTIONS = [
  "STAFF_CREATED",
  "STAFF_UPDATED",
  "STAFF_RANK_CHANGED",
  "STAFF_ARCHIVED",
  "STAFF_RESTORED",
  "HOURS_LOGGED",
  "HOURS_BULK_LOGGED",
  "HOURS_UPDATED",
  "HOURS_VOIDED",
  "WEEK_CREATED",
  "WEEK_UPDATED",
  "WEEK_CLOSED",
  "WEEK_REOPENED",
  "WEEK_DELETED",
  "WEEK_MEMBER_ADDED",
  "PAYMENT_CREATED",
  "PAYMENT_BULK_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_VOIDED",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_PASSWORD_RESET",
  "USER_PASSWORD_CHANGED",
  "USER_SESSIONS_REVOKED",
  "RATE_UPDATED",
  "SETTING_UPDATED",
  "DATA_EXPORTED",
  "DATA_IMPORTED",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  STAFF_CREATED: "Alta de miembro",
  STAFF_UPDATED: "Edición de miembro",
  STAFF_RANK_CHANGED: "Cambio de rango",
  STAFF_ARCHIVED: "Archivado de miembro",
  STAFF_RESTORED: "Reincorporación de miembro",
  HOURS_LOGGED: "Registro de horas",
  HOURS_BULK_LOGGED: "Registro masivo de horas",
  HOURS_UPDATED: "Corrección de horas",
  HOURS_VOIDED: "Anulación de horas",
  WEEK_CREATED: "Creación de período",
  WEEK_UPDATED: "Edición de período",
  WEEK_CLOSED: "Cierre de período",
  WEEK_REOPENED: "Reapertura de período",
  WEEK_DELETED: "Borrado de período",
  WEEK_MEMBER_ADDED: "Miembro agregado al período",
  PAYMENT_CREATED: "Registro de pago",
  PAYMENT_BULK_CREATED: "Registro masivo de pagos",
  PAYMENT_UPDATED: "Edición de pago",
  PAYMENT_VOIDED: "Anulación de pago",
  USER_CREATED: "Alta de usuario",
  USER_UPDATED: "Edición de usuario",
  USER_PASSWORD_RESET: "Restablecimiento de contraseña",
  USER_PASSWORD_CHANGED: "Cambio de contraseña",
  USER_SESSIONS_REVOKED: "Revocación de sesiones",
  RATE_UPDATED: "Cambio de tarifa",
  SETTING_UPDATED: "Cambio de configuración",
  DATA_EXPORTED: "Exportación de datos",
  DATA_IMPORTED: "Importación de datos",
};

export const auditFiltersSchema = paginationSchema.extend({
  search: searchTermSchema,
  action: z.enum(AUDIT_ACTIONS).optional(),
  entity: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
  actorId: uuidSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  sortDir: sortDirectionSchema,
});

export type AuditFilters = z.infer<typeof auditFiltersSchema>;

export const SECURITY_EVENT_TYPES = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "LOGIN_BLOCKED",
  "LOGOUT",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "PASSWORD_CHANGED",
  "PASSWORD_RESET",
  "PERMISSION_DENIED",
  "ACCOUNT_LOCKED",
  "ACCOUNT_DEACTIVATED",
  "CSRF_REJECTED",
  "SUSPICIOUS_REQUEST",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export const securityFiltersSchema = paginationSchema.extend({
  eventType: z.enum(SECURITY_EVENT_TYPES).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  search: searchTermSchema,
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

export type SecurityFilters = z.infer<typeof securityFiltersSchema>;

/* -------------------------------------------------------------------------- */
/* Exportación                                                                */
/* -------------------------------------------------------------------------- */

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_DATASETS = [
  "liquidacion",
  "horas",
  "pagos",
  "staff",
  "auditoria",
  "estadisticas",
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export const exportRequestSchema = z.object({
  dataset: z.enum(EXPORT_DATASETS),
  format: z.enum(EXPORT_FORMATS),
  weekId: uuidSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
});

export type ExportRequest = z.infer<typeof exportRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Importación                                                                */
/* -------------------------------------------------------------------------- */

export const importPreviewSchema = z.object({
  weekId: uuidSchema,
  /** Contenido CSV crudo. Se acota para que un archivo enorme no tumbe el proceso. */
  content: z
    .string()
    .min(1, "El archivo está vacío.")
    .max(2_000_000, "El archivo es demasiado grande (máximo 2 MB)."),
  filename: optionalText(200, "El nombre del archivo"),
});

export type ImportPreviewInput = z.infer<typeof importPreviewSchema>;

export const importCommitSchema = importPreviewSchema.extend({
  confirmation: z.literal("IMPORTAR", {
    message: "Escribí IMPORTAR en mayúsculas para confirmar.",
  }),
  /** Índices de fila (base 0) que el usuario decidió omitir tras la vista previa. */
  skipRows: z.array(z.coerce.number().int().min(0)).max(10_000).default([]),
});

export type ImportCommitInput = z.infer<typeof importCommitSchema>;
