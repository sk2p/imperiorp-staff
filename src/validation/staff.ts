import { z } from "zod";

import { STAFF_RANKS } from "@/domain/ranks";
import {
  calendarDateSchema,
  cleanText,
  optionalText,
  paginationSchema,
  reasonSchema,
  searchTermSchema,
  sortDirectionSchema,
  sortFieldSchema,
  uuidSchema,
  versionSchema,
} from "./common";

/**
 * Contratos de entrada para miembros del staff.
 *
 * `category` NO se acepta del cliente: se deriva del rango en el servidor. Si
 * se admitiera, alguien podría mandar rango MOD con categoría ADMINISTRACION y
 * ensuciar todas las estadísticas por rango.
 */

export const rankSchema = z.enum(STAFF_RANKS, {
  message: "Seleccioná un rango válido del staff.",
});

const nameSchema = cleanText(2, 60, "El nombre").refine(
  (value) => /^[\p{L}\p{N} ._'-]+$/u.test(value),
  "El nombre sólo admite letras, números, espacios y los signos . _ ' -",
);

export const createStaffSchema = z.object({
  name: nameSchema,
  rank: rankSchema,
  inGameId: optionalText(40, "El ID en el servidor"),
  discordTag: optionalText(40, "El usuario de Discord"),
  joinedAt: calendarDateSchema.optional().nullable(),
  notes: optionalText(1000, "Las notas"),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  name: nameSchema,
  inGameId: optionalText(40, "El ID en el servidor"),
  discordTag: optionalText(40, "El usuario de Discord"),
  joinedAt: calendarDateSchema.optional().nullable(),
  notes: optionalText(1000, "Las notas"),
});

export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

/**
 * El cambio de rango es una operación aparte de la edición general: altera la
 * tarifa futura, necesita permiso propio y deja su propia entrada de historial.
 */
export const changeRankSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  rank: rankSchema,
  reason: reasonSchema,
});

export type ChangeRankInput = z.infer<typeof changeRankSchema>;

export const archiveStaffSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  /** Confirmación explícita escrita por el usuario: el nombre del miembro. */
  confirmName: z.string().min(1, "Escribí el nombre del miembro para confirmar."),
});

export type ArchiveStaffInput = z.infer<typeof archiveStaffSchema>;

export const restoreStaffSchema = z.object({
  id: uuidSchema,
  reason: reasonSchema,
});

export const staffFiltersSchema = paginationSchema.extend({
  search: searchTermSchema,
  rank: z.enum(STAFF_RANKS).optional(),
  category: z.enum(["SOPORTE", "MODERACION", "ADMINISTRACION", "DIRECCION"]).optional(),
  status: z.enum(["all", "active", "archived"]).default("active"),
  sortBy: sortFieldSchema(["name", "rank", "createdAt", "minutes"] as const, "name"),
  sortDir: sortDirectionSchema,
});

export type StaffFilters = z.infer<typeof staffFiltersSchema>;
