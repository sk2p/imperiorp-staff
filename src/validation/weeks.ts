import { z } from "zod";

import { MAX_PERIOD_DAYS, periodLengthInDays } from "@/domain/periods";
import {
  calendarDateSchema,
  optionalText,
  paginationSchema,
  reasonSchema,
  sortDirectionSchema,
  uuidSchema,
  versionSchema,
} from "./common";

/** Contratos de entrada para los períodos de liquidación. */

const periodRange = z
  .object({
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
  })
  .refine((value) => value.startDate <= value.endDate, {
    message: "La fecha de inicio no puede ser posterior a la de fin.",
    path: ["endDate"],
  })
  .refine((value) => periodLengthInDays(value.startDate, value.endDate) <= MAX_PERIOD_DAYS, {
    message: "El período no puede abarcar más de " + MAX_PERIOD_DAYS + " días.",
    path: ["endDate"],
  });

export const createWeekSchema = z.intersection(
  periodRange,
  z.object({
    label: optionalText(80, "La etiqueta"),
    notes: optionalText(1000, "Las notas"),
    /**
     * Copia los miembros activos al período apenas se crea, de modo que la
     * liquidación arranque con todos en cero y nadie quede fuera por olvido.
     */
    seedActiveStaff: z.coerce.boolean().default(true),
  }),
);

export type CreateWeekInput = z.infer<typeof createWeekSchema>;

export const updateWeekSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  label: optionalText(80, "La etiqueta"),
  notes: optionalText(1000, "Las notas"),
});

export type UpdateWeekInput = z.infer<typeof updateWeekSchema>;

/**
 * Cerrar un período congela la historia. Se exige confirmación escrita porque
 * revertirlo requiere un permiso que casi nadie tiene.
 */
export const closeWeekSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  /** El usuario tipea CERRAR. Evita el cierre por un click accidental. */
  confirmation: z.literal("CERRAR", {
    message: "Escribí CERRAR en mayúsculas para confirmar el cierre del período.",
  }),
  /** Aceptar seguir adelante pese a las advertencias detectadas. */
  acknowledgeWarnings: z.coerce.boolean().default(false),
});

export type CloseWeekInput = z.infer<typeof closeWeekSchema>;

export const reopenWeekSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  confirmation: z.literal("REABRIR", {
    message: "Escribí REABRIR en mayúsculas para confirmar.",
  }),
});

export type ReopenWeekInput = z.infer<typeof reopenWeekSchema>;

/** Agrega un miembro a un período abierto que todavía no lo incluía. */
export const addMemberToWeekSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
});

export const weekFiltersSchema = paginationSchema.extend({
  status: z.enum(["all", "open", "closed"]).default("all"),
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  sortDir: sortDirectionSchema,
});

export type WeekFilters = z.infer<typeof weekFiltersSchema>;
