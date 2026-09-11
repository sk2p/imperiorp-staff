import { z } from "zod";

import { DAY_STATUSES } from "@/domain/groups";
import { STAFF_GROUPS } from "@/domain/groups";
import { MAX_MONEY_UNITS } from "@/domain/money";
import { STAFF_RANKS } from "@/domain/ranks";
import { MAX_MINUTES_PER_ENTRY } from "@/domain/time";
import { calendarDateSchema, optionalText, uuidSchema } from "./common";

/** Contratos de la planilla semanal. */

export const setCellSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  workDate: calendarDateSchema,
  /** Minutos del día. Cero limpia la casilla. */
  minutes: z.coerce
    .number()
    .int("Los minutos deben ser un número entero.")
    .min(0, "No puede ser negativo.")
    .max(MAX_MINUTES_PER_ENTRY, "Un día no puede superar las 24 horas."),
});

export type SetCellInput = z.infer<typeof setCellSchema>;

/** Estado de un día concreto, no de la semana entera. */
export const setDayStatusSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  workDate: calendarDateSchema,
  status: z.enum(DAY_STATUSES, { message: "Estado desconocido." }),
});

export type SetDayStatusInput = z.infer<typeof setDayStatusSchema>;

/** Cambio de rango desde la planilla, con click derecho sobre la etiqueta. */
export const changeRankInlineSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  rank: z.enum(STAFF_RANKS, { message: "Rango desconocido." }),
});

export type ChangeRankInlineInput = z.infer<typeof changeRankInlineSchema>;

export const reorderSchema = z.object({
  staffMemberIds: z
    .array(uuidSchema)
    .min(1, "No hay nada que ordenar.")
    .max(500, "Demasiados elementos."),
});

export type ReorderInput = z.infer<typeof reorderSchema>;

/**
 * Baja rápida desde la planilla. No borra: archiva, conservando el historial.
 */
export const removeFromGridSchema = z.object({
  staffMemberId: uuidSchema,
  reason: optionalText(500, "El motivo"),
});

export type RemoveFromGridInput = z.infer<typeof removeFromGridSchema>;

/* -------------------------------------------------------------------------- */
/* Configuración de la planilla                                               */
/* -------------------------------------------------------------------------- */

const rateValue = z.coerce
  .number()
  .int("La tarifa debe ser un número entero.")
  .positive("La tarifa tiene que ser mayor a cero.")
  .max(MAX_MONEY_UNITS, "La tarifa supera el máximo admitido.");

/**
 * Tarifa por grupo. Se aplica a todos los rangos de esa familia: dentro de
 * Moderación, un MOD y un MOD++ cobran lo mismo, y mantenerlo así evita que se
 * desincronicen sin que nadie lo note.
 */
export const updateGroupRatesSchema = z.object({
  LOW_STAFF: rateValue,
  MID_STAFF: rateValue,
  HIGH_STAFF: rateValue,
});

export type UpdateGroupRatesInput = z.infer<typeof updateGroupRatesSchema>;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "El color debe ser un hexadecimal como #a855f7.");

export const updateRankColorsSchema = z.object({
  /** Pares `RANGO=#rrggbb`, uno por rango que se quiera cambiar. */
  colors: z
    .array(z.string())
    .min(1, "No hay colores que guardar.")
    .max(STAFF_RANKS.length)
    .transform((pairs) =>
      pairs
        .map((pair) => {
          const [rank, color] = pair.split("=");
          return { rank, color };
        })
        .filter(
          (entry): entry is { rank: string; color: string } =>
            entry.rank !== undefined && entry.color !== undefined,
        ),
    )
    .pipe(
      z.array(
        z.object({
          rank: z.enum(STAFF_RANKS, { message: "Rango desconocido." }),
          color: hexColor,
        }),
      ),
    ),
});

export type UpdateRankColorsInput = z.infer<typeof updateRankColorsSchema>;

export const resetWeekSchema = z.object({
  weekId: uuidSchema,
  confirmation: z.literal("REINICIAR", {
    message: "Escribí REINICIAR en mayúsculas para confirmar.",
  }),
});

export type ResetWeekInput = z.infer<typeof resetWeekSchema>;

export const GROUP_RATE_KEYS = STAFF_GROUPS;
