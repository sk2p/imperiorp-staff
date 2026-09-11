import { z } from "zod";

import { WEEKLY_STATUSES } from "@/domain/groups";
import { MAX_MINUTES_PER_ENTRY } from "@/domain/time";
import { calendarDateSchema, optionalText, uuidSchema } from "./common";

/** Contratos de la planilla semanal. */

export const setCellSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  workDate: calendarDateSchema,
  /** Minutos del día. Cero anula la casilla. */
  minutes: z.coerce
    .number()
    .int("Los minutos deben ser un número entero.")
    .min(0, "No puede ser negativo.")
    .max(MAX_MINUTES_PER_ENTRY, "Un día no puede superar las 24 horas."),
  note: optionalText(200, "La nota"),
});

export type SetCellInput = z.infer<typeof setCellSchema>;

export const setStatusSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  status: z.enum(WEEKLY_STATUSES, { message: "Estado desconocido." }),
  note: optionalText(200, "La nota"),
});

export type SetStatusInput = z.infer<typeof setStatusSchema>;

export const reorderSchema = z.object({
  /** Lista completa del grupo, en el orden final deseado. */
  staffMemberIds: z
    .array(uuidSchema)
    .min(1, "No hay nada que ordenar.")
    .max(500, "Demasiados elementos."),
});

export type ReorderInput = z.infer<typeof reorderSchema>;

/**
 * Baja rápida desde la planilla.
 *
 * No borra: archiva, igual que desde la ficha del miembro. La diferencia es que
 * acá no se pide escribir el nombre para confirmar, porque la planilla ya
 * muestra de quién se trata y el diálogo lo repite. El historial se conserva
 * intacto y la operación es reversible.
 */
export const removeFromGridSchema = z.object({
  staffMemberId: uuidSchema,
  reason: optionalText(500, "El motivo"),
});

export type RemoveFromGridInput = z.infer<typeof removeFromGridSchema>;
