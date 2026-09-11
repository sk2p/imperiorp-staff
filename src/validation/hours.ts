import { z } from "zod";

import { MAX_MINUTES_PER_ENTRY } from "@/domain/time";
import {
  calendarDateSchema,
  cleanText,
  paginationSchema,
  reasonSchema,
  searchTermSchema,
  sortDirectionSchema,
  sortFieldSchema,
  uuidSchema,
  versionSchema,
} from "./common";

/**
 * Contratos de entrada para el registro de horas.
 *
 * El cliente manda horas y minutos por separado, que es como los escribe una
 * persona. El servidor los convierte a minutos enteros de inmediato y a partir
 * de ahí no vuelve a existir ninguna otra representación.
 */

const hoursPart = z.coerce
  .number()
  .int("Las horas deben ser un número entero.")
  .min(0, "Las horas no pueden ser negativas.")
  .max(24, "No se puede cargar más de 24 horas en una sola entrada.");

const minutesPart = z.coerce
  .number()
  .int("Los minutos deben ser un número entero.")
  .min(0, "Los minutos no pueden ser negativos.")
  .max(59, "Los minutos deben estar entre 0 y 59.");

const durationFields = {
  hours: hoursPart,
  minutes: minutesPart,
};

/** Suma horas y minutos y valida el total contra los topes del dominio. */
const withTotalMinutes = <T extends { hours: number; minutes: number }>(schema: z.ZodType<T>) =>
  schema
    .transform((value) => ({ ...value, totalMinutes: value.hours * 60 + value.minutes }))
    .refine((value) => value.totalMinutes > 0, {
      message: "La duración tiene que ser mayor a cero.",
      path: ["hours"],
    })
    .refine((value) => value.totalMinutes <= MAX_MINUTES_PER_ENTRY, {
      message: "Una entrada no puede superar las 24 horas. Cargá una por día.",
      path: ["hours"],
    });

export const createHourEntrySchema = withTotalMinutes(
  z.object({
    staffMemberId: uuidSchema,
    weekId: uuidSchema,
    workDate: calendarDateSchema,
    reason: cleanText(3, 200, "La descripción del turno"),
    ...durationFields,
  }),
);

export type CreateHourEntryInput = z.infer<typeof createHourEntrySchema>;

/**
 * Carga rápida de varias entradas de una sola vez, desde la pantalla de horas.
 * Se aplica como una única transacción: o entran todas o no entra ninguna.
 */
export const bulkHourEntriesSchema = z.object({
  weekId: uuidSchema,
  workDate: calendarDateSchema,
  reason: cleanText(3, 200, "La descripción del turno"),
  entries: z
    .array(
      z.object({
        staffMemberId: uuidSchema,
        hours: hoursPart,
        minutes: minutesPart,
      }),
    )
    .min(1, "Seleccioná al menos un miembro.")
    .max(60, "No se pueden cargar más de 60 miembros a la vez."),
});

export type BulkHourEntriesInput = z.infer<typeof bulkHourEntriesSchema>;

export const updateHourEntrySchema = withTotalMinutes(
  z.object({
    id: uuidSchema,
    expectedVersion: versionSchema,
    workDate: calendarDateSchema,
    reason: cleanText(3, 200, "La descripción del turno"),
    /** Por qué se corrige. Queda en la auditoría junto al antes y el después. */
    changeReason: reasonSchema,
    ...durationFields,
  }),
);

export type UpdateHourEntryInput = z.infer<typeof updateHourEntrySchema>;

export const voidHourEntrySchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
});

export type VoidHourEntryInput = z.infer<typeof voidHourEntrySchema>;

export const hourFiltersSchema = paginationSchema.extend({
  weekId: uuidSchema.optional(),
  staffMemberId: uuidSchema.optional(),
  search: searchTermSchema,
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  includeVoided: z.coerce.boolean().default(false),
  sortBy: sortFieldSchema(["workDate", "minutes", "createdAt", "staffName"] as const, "workDate"),
  sortDir: sortDirectionSchema,
});

export type HourFilters = z.infer<typeof hourFiltersSchema>;
