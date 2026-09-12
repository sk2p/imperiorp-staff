import { z } from "zod";

import { MAX_MONEY_UNITS } from "@/domain/money";
import {
  idempotencyKeySchema,
  optionalText,
  paginationSchema,
  reasonSchema,
  searchTermSchema,
  sortDirectionSchema,
  sortFieldSchema,
  uuidSchema,
  versionSchema,
} from "./common";

/** Contratos de entrada para pagos y liquidaciones. */

export const PAYMENT_METHODS = ["in_game", "transferencia", "efectivo", "otro"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  in_game: "Dentro del servidor",
  transferencia: "Transferencia",
  efectivo: "Efectivo",
  otro: "Otro",
};

const amountSchema = z.coerce
  .number()
  .int("El importe debe ser un número entero de unidades.")
  .positive("El importe tiene que ser mayor a cero.")
  .max(MAX_MONEY_UNITS, "El importe supera el máximo admitido.");

/**
 * Registrar un pago.
 *
 * `expectedAmount` es la pieza clave: es el importe que la pantalla le mostró
 * al usuario. Si la liquidación cambió entre que abrió el formulario y
 * confirmó, el servidor lo detecta y frena la operación en vez de pagar un
 * número que nadie revisó.
 */
export const createPaymentSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  expectedAmount: amountSchema,
  /** Importe realmente abonado. Por defecto coincide con el esperado. */
  amount: amountSchema.optional(),
  method: z.enum(PAYMENT_METHODS).default("in_game"),
  paymentReference: optionalText(80, "La referencia"),
  notes: optionalText(500, "Las notas"),
  idempotencyKey: idempotencyKeySchema,
  /** Habilita pagar un importe distinto al calculado, con motivo obligatorio. */
  allowAmountMismatch: z.coerce.boolean().default(false),
  mismatchReason: optionalText(500, "El motivo de la diferencia"),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

/** Pago masivo de todas las liquidaciones pendientes de un período. */
export const bulkPaymentSchema = z.object({
  weekId: uuidSchema,
  staffMemberIds: z
    .array(uuidSchema)
    .min(1, "Seleccioná al menos una liquidación.")
    .max(200, "No se pueden registrar más de 200 pagos a la vez."),
  method: z.enum(PAYMENT_METHODS).default("in_game"),
  notes: optionalText(500, "Las notas"),
  idempotencyKey: idempotencyKeySchema,
  confirmation: z.literal("PAGAR", {
    message: "Escribí PAGAR en mayúsculas para confirmar el pago masivo.",
  }),
});

export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>;

export const updatePaymentSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  method: z.enum(PAYMENT_METHODS),
  paymentReference: optionalText(80, "La referencia"),
  notes: optionalText(500, "Las notas"),
  reason: reasonSchema,
});

export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

/**
 * Anular un pago. Nunca se borra: se marca anulado, lo que libera el índice
 * único y permite registrar el pago correcto sin perder rastro del error.
 */
export const voidPaymentSchema = z.object({
  id: uuidSchema,
  expectedVersion: versionSchema,
  reason: reasonSchema,
  confirmation: z.literal("ANULAR", {
    message: "Escribí ANULAR en mayúsculas para confirmar.",
  }),
});

export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;

export const paymentFiltersSchema = paginationSchema.extend({
  weekId: uuidSchema.optional(),
  staffMemberId: uuidSchema.optional(),
  search: searchTermSchema,
  status: z.enum(["all", "pending", "paid", "voided"]).default("all"),
  method: z.enum(PAYMENT_METHODS).optional(),
  sortBy: sortFieldSchema(["paidAt", "amount", "staffName"] as const, "paidAt"),
  sortDir: sortDirectionSchema,
});

export type PaymentFilters = z.infer<typeof paymentFiltersSchema>;

/**
 * Marcar o desmarcar el pago de un miembro desde el tablero.
 *
 * Sin importe ni método: el tablero paga siempre lo calculado. Cualquier pago
 * por un importe distinto pasa por el formulario completo, que exige el motivo.
 */
export const togglePaymentSchema = z.object({
  weekId: uuidSchema,
  staffMemberId: uuidSchema,
  paid: z.coerce.boolean(),
});

export type TogglePaymentInput = z.infer<typeof togglePaymentSchema>;
