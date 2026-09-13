import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, withSerializableTransaction, withTransaction, type Transaction } from "@/db";
import {
  payments,
  rankRates,
  staffMembers,
  weeklyStaffRecords,
  weeks,
  type Payment,
} from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import {
  businessRule,
  concurrency,
  conflict,
  isUniqueViolation,
  notFound,
  validation,
} from "@/lib/core/errors";
import { DEFAULT_RANK_COLORS, GROUP_LIST, groupForRank, type StaffGroup } from "@/domain/groups";
import { formatMoney } from "@/domain/money";
import { RANK_DEFINITIONS, isStaffRank, rankBaseOrder } from "@/domain/ranks";
import { formatPeriodLabel } from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import { containsPattern, offsetFor, paginate, type Paginated } from "@/validation/common";
import type {
  BulkPaymentInput,
  CreatePaymentInput,
  PaymentFilters,
  UpdatePaymentInput,
  VoidPaymentInput,
} from "@/validation/payments";
import { appendAuditLog } from "./audit";
import { notifyPayment } from "./discord-notify";
/**
 * IMPERIO RP — Pagos de liquidaciones.
 *
 * REGLA CENTRAL: una liquidación vigente por miembro y período. La hace cumplir
 * un índice único parcial en PostgreSQL, no una consulta previa en JavaScript.
 * La diferencia importa: dos clicks simultáneos en "Pagar" llegan a la base al
 * mismo tiempo, las dos consultas previas verían "sin pagos" y las dos
 * insertarían. Con el índice, una gana y la otra recibe un error que se traduce
 * en un mensaje claro.
 *
 * SÓLO SE PAGAN PERÍODOS CERRADOS. Mientras un período está abierto sus horas
 * pueden cambiar, y pagar un importe que después se mueve es exactamente el
 * problema que este sistema existe para evitar.
 */
/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */
export interface SettlementRow {
  readonly staffMemberId: string;
  readonly recordId: string;
  readonly name: string;
  readonly rank: string;
  readonly category: string;
  readonly hourlyRate: number;
  readonly totalMinutes: number;
  readonly amount: number;
  readonly frozenAt: Date | null;
  /* Pago, si existe */
  readonly paymentId: string | null;
  readonly paidAmount: number | null;
  readonly paidAt: Date | null;
  readonly paidByUsername: string | null;
  readonly paymentMethod: string | null;
  readonly paymentReference: string | null;
  readonly paymentNotes: string | null;
  readonly paymentVersion: number | null;
}
/**
 * Estado de liquidación de un período: una fila por miembro, con el pago
 * asociado si ya se registró. Resuelve de un saque las dos listas que pide la
 * pantalla de pagos, pendientes y pagados.
 */
export async function getSettlement(weekId: string): Promise<SettlementRow[]> {
  return db
    .select({
      staffMemberId: weeklyStaffRecords.staffMemberId,
      recordId: weeklyStaffRecords.id,
      name: weeklyStaffRecords.staffNameSnapshot,
      rank: weeklyStaffRecords.rankSnapshot,
      category: weeklyStaffRecords.categorySnapshot,
      hourlyRate: weeklyStaffRecords.hourlyRateSnapshot,
      totalMinutes: weeklyStaffRecords.totalMinutes,
      amount: weeklyStaffRecords.calculatedAmount,
      frozenAt: weeklyStaffRecords.frozenAt,
      paymentId: payments.id,
      paidAmount: payments.amount,
      paidAt: payments.paidAt,
      paidByUsername: payments.paidByUsername,
      paymentMethod: payments.method,
      paymentReference: payments.paymentReference,
      paymentNotes: payments.notes,
      paymentVersion: payments.version,
    })
    .from(weeklyStaffRecords)
    .leftJoin(
      payments,
      and(
        eq(payments.weekId, weeklyStaffRecords.weekId),
        eq(payments.staffMemberId, weeklyStaffRecords.staffMemberId),
        isNull(payments.voidedAt),
      ),
    )
    .where(eq(weeklyStaffRecords.weekId, weekId))
    .orderBy(desc(weeklyStaffRecords.calculatedAmount), asc(weeklyStaffRecords.staffNameSnapshot));
}
export interface PaymentView {
  readonly id: string;
  readonly weekId: string;
  readonly weekCode: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly staffMemberId: string;
  readonly staffName: string;
  readonly rank: string;
  readonly totalMinutes: number;
  readonly amount: number;
  readonly expectedAmount: number;
  readonly method: string;
  readonly paymentReference: string | null;
  readonly notes: string | null;
  readonly paidAt: Date;
  readonly paidByUsername: string;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly version: number;
}
export async function listPayments(filters: PaymentFilters): Promise<Paginated<PaymentView>> {
  const conditions: SQL[] = [];
  if (filters.weekId) conditions.push(eq(payments.weekId, filters.weekId));
  if (filters.staffMemberId) conditions.push(eq(payments.staffMemberId, filters.staffMemberId));
  if (filters.method) conditions.push(eq(payments.method, filters.method));
  if (filters.status === "paid") conditions.push(isNull(payments.voidedAt));
  if (filters.status === "voided") conditions.push(isNotNull(payments.voidedAt));
  if (filters.search) {
    const pattern = containsPattern(filters.search);
    const matches = or(
      sql`${staffMembers.name} ilike ${pattern}`,
      sql`${payments.paidByUsername} ilike ${pattern}`,
      sql`${payments.paymentReference} ilike ${pattern}`,
    );
    if (matches) conditions.push(matches);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const direction = filters.sortDir === "asc" ? asc : desc;
  const orderBy =
    filters.sortBy === "amount"
      ? [direction(payments.amount)]
      : filters.sortBy === "staffName"
        ? [direction(staffMembers.name)]
        : [direction(payments.paidAt)];
  const [items, [countRow]] = await Promise.all([
    db
      .select({
        id: payments.id,
        weekId: payments.weekId,
        weekCode: weeks.code,
        weekStart: weeks.startDate,
        weekEnd: weeks.endDate,
        staffMemberId: payments.staffMemberId,
        staffName: staffMembers.name,
        rank: sql<string>`coalesce((
          select w.rank_snapshot from weekly_staff_records w
          where w.week_id = ${payments.weekId} and w.staff_member_id = ${payments.staffMemberId}
        ), ${staffMembers.rank})`,
        totalMinutes: sql<number>`coalesce((
          select w.total_minutes from weekly_staff_records w
          where w.week_id = ${payments.weekId} and w.staff_member_id = ${payments.staffMemberId}
        ), 0)`,
        amount: payments.amount,
        expectedAmount: payments.expectedAmount,
        method: payments.method,
        paymentReference: payments.paymentReference,
        notes: payments.notes,
        paidAt: payments.paidAt,
        paidByUsername: payments.paidByUsername,
        voidedAt: payments.voidedAt,
        voidReason: payments.voidReason,
        version: payments.version,
      })
      .from(payments)
      .innerJoin(staffMembers, eq(payments.staffMemberId, staffMembers.id))
      .innerJoin(weeks, eq(payments.weekId, weeks.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(payments)
      .innerJoin(staffMembers, eq(payments.staffMemberId, staffMembers.id))
      .where(where),
  ]);
  return paginate(items, countRow?.value ?? 0, filters);
}
export interface PaymentSummary {
  readonly pendingCount: number;
  readonly pendingAmount: number;
  readonly paidCount: number;
  readonly paidAmount: number;
  readonly totalAmount: number;
}
export async function getPaymentSummary(weekId: string): Promise<PaymentSummary> {
  const rows = await getSettlement(weekId);
  let pendingCount = 0;
  let pendingAmount = 0;
  let paidCount = 0;
  let paidAmount = 0;
  for (const row of rows) {
    if (row.paymentId) {
      paidCount += 1;
      paidAmount += row.paidAmount ?? 0;
    } else if (row.amount > 0) {
      pendingCount += 1;
      pendingAmount += row.amount;
    }
  }
  return {
    pendingCount,
    pendingAmount,
    paidCount,
    paidAmount,
    totalAmount: rows.reduce((sum, row) => sum + row.amount, 0),
  };
}
export async function getPayment(id: string): Promise<Payment | null> {
  const [payment] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  return payment ?? null;
}
export async function listRecentPayments(limit = 8): Promise<PaymentView[]> {
  const result = await listPayments({
    page: 1,
    pageSize: limit,
    status: "paid",
    sortBy: "paidAt",
    sortDir: "desc",
    search: null,
  });
  return [...result.items];
}
/* -------------------------------------------------------------------------- */
/* Registro de pagos                                                          */
/* -------------------------------------------------------------------------- */
interface SettlementContext {
  readonly record: typeof weeklyStaffRecords.$inferSelect;
  readonly week: typeof weeks.$inferSelect;
  readonly memberName: string;
}
/**
 * Carga y bloquea la liquidación de un miembro, verificando que el período esté
 * cerrado. El bloqueo evita que una reapertura simultánea cambie el importe
 * entre la verificación y el insert.
 */
async function loadSettlementForPayment(
  tx: Transaction,
  weekId: string,
  staffMemberId: string,
  allowOpenPeriod = false,
): Promise<SettlementContext> {
  const [week] = await tx.select().from(weeks).where(eq(weeks.id, weekId)).limit(1).for("update");
  if (!week) throw notFound("El período");
  /**
   * El formulario de pago exige el período cerrado: ahí se escribe un importe
   * a mano y no tiene sentido hacerlo contra horas que todavía se mueven.
   *
   * El tablero es otra cosa. Ahí se va tildando a quien ya cobró, muchas veces
   * el mismo sábado antes de cerrar, y bloquearlo convertía la pantalla en un
   * adorno. Paga siempre el importe calculado, y si las horas cambian después
   * el tablero muestra la diferencia en vez de taparla.
   */
  if (week.status !== "closed" && !allowOpenPeriod) {
    throw businessRule(
      "El período " +
        formatPeriodLabel(week.startDate, week.endDate) +
        " todavía está abierto. Cerralo antes de registrar pagos: mientras siga abierto, las horas pueden cambiar y el importe dejaría de coincidir.",
    );
  }
  const [record] = await tx
    .select()
    .from(weeklyStaffRecords)
    .where(
      and(
        eq(weeklyStaffRecords.weekId, weekId),
        eq(weeklyStaffRecords.staffMemberId, staffMemberId),
      ),
    )
    .limit(1)
    .for("update");
  if (!record) {
    throw notFound("La liquidación de ese miembro en este período");
  }
  if (record.calculatedAmount <= 0) {
    throw businessRule(
      record.staffNameSnapshot + " no tiene horas en este período: no hay nada que pagar.",
    );
  }
  return { record, week, memberName: record.staffNameSnapshot };
}
export async function createPayment(
  input: CreatePaymentInput,
  actor: ActorContext,
  /** Sólo el tablero lo usa: ver `loadSettlementForPayment`. */
  allowOpenPeriod = false,
): Promise<Payment> {
  return withSerializableTransaction(async (tx) => {
    // Reintento seguro: si la misma clave ya se usó, se devuelve aquel pago en
    // vez de crear uno nuevo. Un doble click o un reintento de red no duplican.
    const [existingByKey] = await tx
      .select()
      .from(payments)
      .where(eq(payments.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existingByKey) return existingByKey;
    const { record, week, memberName } = await loadSettlementForPayment(
      tx,
      input.weekId,
      input.staffMemberId,
      allowOpenPeriod,
    );
    /**
     * El importe que vio el usuario debe coincidir con el vigente. Si no
     * coincide, la liquidación cambió mientras el formulario estaba abierto y
     * confirmar a ciegas sería pagar un número que nadie revisó.
     */
    if (input.expectedAmount !== record.calculatedAmount) {
      throw conflict(
        "La liquidación de " +
          memberName +
          " cambió: la pantalla mostraba " +
          formatMoney(input.expectedAmount) +
          " y ahora corresponden " +
          formatMoney(record.calculatedAmount) +
          ". Recargá y revisá antes de pagar.",
      );
    }
    const amount = input.amount ?? record.calculatedAmount;
    if (amount !== record.calculatedAmount) {
      if (!input.allowAmountMismatch) {
        throw validation("El importe no coincide con la liquidación.", {
          amount: [
            "Corresponden " +
              formatMoney(record.calculatedAmount) +
              ". Para pagar otro importe, marcá la opción y explicá por qué.",
          ],
        });
      }
      if (!input.mismatchReason || input.mismatchReason.trim().length < 5) {
        throw validation("Falta el motivo de la diferencia.", {
          mismatchReason: ["Explicá por qué se paga un importe distinto al calculado."],
        });
      }
    }
    const paidAt = new Date();
    let created: Payment | undefined;
    try {
      [created] = await tx
        .insert(payments)
        .values({
          weekId: input.weekId,
          staffMemberId: input.staffMemberId,
          weeklyRecordId: record.id,
          amount,
          expectedAmount: record.calculatedAmount,
          paidAt,
          paidBy: actor.id,
          paidByUsername: actor.username,
          method: input.method,
          paymentReference: input.paymentReference,
          notes: input.notes,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error, "payments_week_staff_active_idx")) {
        throw conflict(
          "Ya hay un pago registrado para " +
            memberName +
            " en este período. Si fue un error, anulá el pago existente antes de registrar otro.",
        );
      }
      if (isUniqueViolation(error, "payments_idempotency_idx")) {
        throw conflict("Este pago ya se estaba registrando. Recargá la pantalla para verlo.");
      }
      throw error;
    }
    if (!created) throw new Error("No se pudo registrar el pago.");
    await appendAuditLog(tx, {
      actor,
      action: "PAYMENT_CREATED",
      entity: "payments",
      entityId: created.id,
      summary:
        "Registró el pago de " +
        formatMoney(created.amount) +
        " a " +
        memberName +
        " por " +
        formatPeriodLabel(week.startDate, week.endDate),
      after: {
        miembro: memberName,
        rango: record.rankSnapshot,
        periodo: formatPeriodLabel(week.startDate, week.endDate),
        horas: formatMinutes(record.totalMinutes),
        tarifa: record.hourlyRateSnapshot,
        importe: created.amount,
        importeCalculado: record.calculatedAmount,
        metodo: created.method,
        referencia: created.paymentReference,
      },
      reason: amount !== record.calculatedAmount ? input.mismatchReason : null,
      metadata: { weekId: input.weekId, staffMemberId: input.staffMemberId },
    });

    /**
     * El aviso a Discord se dispara y no se espera.
     *
     * Va dentro de la transacción sólo porque acá están todos los datos a mano;
     * no la retiene: `notifyPayment` no lanza nunca y se encarga sola de sus
     * errores. Un problema de Discord no puede voltear un pago ya registrado.
     */
    void notifyPayment({
      staffName: memberName,
      rank: record.rankSnapshot,
      amount: created.amount,
      minutes: record.totalMinutes,
      period: formatPeriodLabel(week.startDate, week.endDate),
      actor: actor.username,
    });

    return created;
  });
}
/**
 * Paga varias liquidaciones pendientes de un mismo período.
 *
 * Las que ya estuvieran pagadas se saltean en lugar de hacer fallar todo el
 * lote: es el comportamiento útil cuando dos personas están liquidando a la vez.
 */
export async function createBulkPayments(
  input: BulkPaymentInput,
  actor: ActorContext,
): Promise<{ created: number; skipped: number; totalAmount: number }> {
  return withSerializableTransaction(async (tx) => {
    const [week] = await tx
      .select()
      .from(weeks)
      .where(eq(weeks.id, input.weekId))
      .limit(1)
      .for("update");
    if (!week) throw notFound("El período");
    if (week.status !== "closed") {
      throw businessRule("El período todavía está abierto. Cerralo antes de registrar pagos.");
    }
    const records = await tx
      .select()
      .from(weeklyStaffRecords)
      .where(
        and(
          eq(weeklyStaffRecords.weekId, input.weekId),
          sql`${weeklyStaffRecords.staffMemberId} in ${input.staffMemberIds}`,
        ),
      )
      .for("update");
    const alreadyPaid = await tx
      .select({ staffMemberId: payments.staffMemberId })
      .from(payments)
      .where(and(eq(payments.weekId, input.weekId), isNull(payments.voidedAt)));
    const paidSet = new Set(alreadyPaid.map((row) => row.staffMemberId));
    const payable = records.filter(
      (record) => !paidSet.has(record.staffMemberId) && record.calculatedAmount > 0,
    );
    const skipped = input.staffMemberIds.length - payable.length;
    if (payable.length === 0) {
      throw businessRule(
        "No quedó ninguna liquidación por pagar: ya estaban pagadas o no tienen horas.",
      );
    }
    const paidAt = new Date();
    const inserted = await tx
      .insert(payments)
      .values(
        payable.map((record, index) => ({
          weekId: input.weekId,
          staffMemberId: record.staffMemberId,
          weeklyRecordId: record.id,
          amount: record.calculatedAmount,
          expectedAmount: record.calculatedAmount,
          paidAt,
          paidBy: actor.id,
          paidByUsername: actor.username,
          method: input.method,
          notes: input.notes,
          // Clave derivada del lote: reintentar el mismo lote no duplica pagos.
          idempotencyKey: (input.idempotencyKey + "-" + index).slice(0, 64),
        })),
      )
      .onConflictDoNothing()
      .returning();
    const totalAmount = inserted.reduce((sum, payment) => sum + payment.amount, 0);
    await appendAuditLog(tx, {
      actor,
      action: "PAYMENT_BULK_CREATED",
      entity: "payments",
      entityId: input.weekId,
      summary:
        "Registró " +
        inserted.length +
        " pagos por " +
        formatMoney(totalAmount) +
        " del período " +
        formatPeriodLabel(week.startDate, week.endDate),
      after: {
        periodo: formatPeriodLabel(week.startDate, week.endDate),
        cantidad: inserted.length,
        total: totalAmount,
        detalle: payable.map((record) => ({
          miembro: record.staffNameSnapshot,
          importe: record.calculatedAmount,
        })),
      },
      metadata: { weekId: input.weekId, omitidos: skipped },
    });
    return { created: inserted.length, skipped, totalAmount };
  });
}
export async function updatePayment(
  input: UpdatePaymentInput,
  actor: ActorContext,
): Promise<Payment> {
  return withTransaction(async (tx) => {
    const existing = await lockPayment(tx, input.id);
    if (existing.voidedAt) {
      throw businessRule("El pago está anulado. No se puede editar.");
    }
    const [updated] = await tx
      .update(payments)
      .set({
        method: input.method,
        paymentReference: input.paymentReference,
        notes: input.notes,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, input.id), eq(payments.version, input.expectedVersion)))
      .returning();
    if (!updated) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "PAYMENT_UPDATED",
      entity: "payments",
      entityId: updated.id,
      summary: "Editó los datos del pago de " + formatMoney(updated.amount),
      before: {
        metodo: existing.method,
        referencia: existing.paymentReference,
        notas: existing.notes,
      },
      after: { metodo: updated.method, referencia: updated.paymentReference, notas: updated.notes },
      reason: input.reason,
    });
    return updated;
  });
}
/**
 * Anula un pago. Libera el índice único para que se pueda registrar el correcto,
 * sin borrar el rastro del error.
 */
export async function voidPayment(input: VoidPaymentInput, actor: ActorContext): Promise<Payment> {
  return withTransaction(async (tx) => {
    const existing = await lockPayment(tx, input.id);
    if (existing.voidedAt) {
      throw businessRule("El pago ya está anulado.");
    }
    const [member] = await tx
      .select({ name: staffMembers.name })
      .from(staffMembers)
      .where(eq(staffMembers.id, existing.staffMemberId))
      .limit(1);
    const [voided] = await tx
      .update(payments)
      .set({
        voidedAt: new Date(),
        voidedBy: actor.id,
        voidReason: input.reason,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, input.id), eq(payments.version, input.expectedVersion)))
      .returning();
    if (!voided) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "PAYMENT_VOIDED",
      entity: "payments",
      entityId: voided.id,
      summary:
        "Anuló el pago de " + formatMoney(existing.amount) + " a " + (member?.name ?? "un miembro"),
      before: {
        miembro: member?.name,
        importe: existing.amount,
        pagadoEl: existing.paidAt,
        registradoPor: existing.paidByUsername,
      },
      after: { anulado: true, motivo: input.reason },
      reason: input.reason,
      metadata: { weekId: existing.weekId, staffMemberId: existing.staffMemberId },
    });

    const [semana] = await tx
      .select({ startDate: weeks.startDate, endDate: weeks.endDate })
      .from(weeks)
      .where(eq(weeks.id, existing.weekId))
      .limit(1);

    void notifyPayment({
      staffName: member?.name ?? "un miembro",
      rank: "—",
      amount: existing.amount,
      minutes: 0,
      period: semana ? formatPeriodLabel(semana.startDate, semana.endDate) : "—",
      actor: actor.username,
      voided: true,
      reason: input.reason,
    });

    return voided;
  });
}
async function lockPayment(tx: Transaction, id: string): Promise<Payment> {
  const [payment] = await tx
    .select()
    .from(payments)
    .where(eq(payments.id, id))
    .limit(1)
    .for("update");
  if (!payment) throw notFound("El pago");
  return payment;
}
/* -------------------------------------------------------------------------- */
/* Vista por miembro                                                          */
/* -------------------------------------------------------------------------- */
export async function getStaffPayments(staffMemberId: string, limit = 26) {
  return db
    .select({
      id: payments.id,
      weekCode: weeks.code,
      weekStart: weeks.startDate,
      weekEnd: weeks.endDate,
      amount: payments.amount,
      paidAt: payments.paidAt,
      paidByUsername: payments.paidByUsername,
      method: payments.method,
      voidedAt: payments.voidedAt,
    })
    .from(payments)
    .innerJoin(weeks, eq(payments.weekId, weeks.id))
    .where(eq(payments.staffMemberId, staffMemberId))
    .orderBy(desc(payments.paidAt))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Tablero de pagos por categoría                                             */
/* -------------------------------------------------------------------------- */

/**
 * El tablero que se usa para pagar.
 *
 * Es la misma liquidación de siempre, reordenada como se paga en la práctica:
 * por bloque —High, Mid, Low—, de mayor a menor rango, con las horas y el
 * importe de cada uno a la vista. El estado se reduce a dos: falta pagar o
 * pagado, que es la única pregunta que se hace quien está repartiendo.
 */
export interface PaymentBoardRow {
  readonly staffMemberId: string;
  readonly recordId: string;
  readonly name: string;
  readonly rank: string;
  readonly rankColor: string;
  readonly totalMinutes: number;
  readonly amount: number;
  readonly paid: boolean;
  readonly paymentId: string | null;
  readonly paymentVersion: number | null;
  readonly paidAmount: number | null;
  readonly paidAt: Date | null;
  readonly paidByUsername: string | null;
}

export interface PaymentBoardGroup {
  readonly group: StaffGroup;
  readonly rows: readonly PaymentBoardRow[];
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly paidAmount: number;
  readonly pendingAmount: number;
  readonly paidCount: number;
  readonly pendingCount: number;
}

export interface PaymentBoard {
  readonly groups: readonly PaymentBoardGroup[];
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly paidAmount: number;
  readonly pendingAmount: number;
  readonly paidCount: number;
  readonly pendingCount: number;
  readonly memberCount: number;
}

/**
 * `settlement` se puede pasar ya resuelto: la pantalla de pagos lo necesita
 * también para el detalle, y traerlo dos veces sería una consulta al pedo.
 */
export async function getPaymentBoard(
  weekId: string,
  settlementRows?: readonly SettlementRow[],
): Promise<PaymentBoard> {
  const [settlement, colors, orden] = await Promise.all([
    settlementRows ?? getSettlement(weekId),
    db.select({ rank: rankRates.rank, color: rankRates.color }).from(rankRates),
    // El orden manual de la planilla, que acá desempata adentro de cada rango.
    db.select({ id: staffMembers.id, displayOrder: staffMembers.displayOrder }).from(staffMembers),
  ]);

  const colorByRank = new Map(colors.map((row) => [row.rank, row.color]));
  const orderById = new Map(orden.map((row) => [row.id, row.displayOrder]));

  const rows: PaymentBoardRow[] = settlement.map((row) => ({
    staffMemberId: row.staffMemberId,
    recordId: row.recordId,
    name: row.name,
    rank: row.rank,
    rankColor: colorByRank.get(row.rank) ?? DEFAULT_RANK_COLORS[row.rank] ?? "#6f747d",
    totalMinutes: row.totalMinutes,
    amount: row.amount,
    paid: row.paymentId !== null,
    paymentId: row.paymentId,
    paymentVersion: row.paymentVersion,
    paidAmount: row.paidAmount,
    paidAt: row.paidAt,
    paidByUsername: row.paidByUsername,
  }));

  const groups = GROUP_LIST.map((definition) => {
    const members = rows
      .filter((row) => groupForRank(row.rank) === definition.group)
      .sort((a, b) => {
        /**
         * Acá manda el RANGO, no el orden manual de la planilla.
         *
         * En la planilla de horas el orden lo elige quien carga: mueve a
         * alguien arriba porque lo está buscando. Pagar es otra tarea — se baja
         * la lista de arriba hacia abajo — y ahí un SDP metido entre los ADM
         * porque alguien lo arrastró la semana pasada se lee como un error.
         *
         * El orden manual sigue valiendo, pero desempata adentro del mismo
         * rango: entre cuatro ADM++ siguen en el orden que alguien eligió.
         */
        const tier = (rank: string) => (isStaffRank(rank) ? RANK_DEFINITIONS[rank].tier : 0);
        const porRango = tier(b.rank) - tier(a.rank);
        if (porRango !== 0) return porRango;

        const ordenA = orderById.get(a.staffMemberId) ?? rankBaseOrder(a.rank);
        const ordenB = orderById.get(b.staffMemberId) ?? rankBaseOrder(b.rank);
        if (ordenA !== ordenB) return ordenA - ordenB;

        return a.name.localeCompare(b.name, "es");
      });

    return {
      group: definition.group,
      rows: members,
      totalMinutes: members.reduce((sum, row) => sum + row.totalMinutes, 0),
      totalAmount: members.reduce((sum, row) => sum + row.amount, 0),
      paidAmount: members.reduce((sum, row) => sum + (row.paid ? (row.paidAmount ?? 0) : 0), 0),
      pendingAmount: members.reduce((sum, row) => sum + (row.paid ? 0 : row.amount), 0),
      paidCount: members.filter((row) => row.paid).length,
      pendingCount: members.filter((row) => !row.paid).length,
    };
  }).filter((group) => group.rows.length > 0);

  return {
    groups,
    totalMinutes: groups.reduce((sum, group) => sum + group.totalMinutes, 0),
    totalAmount: groups.reduce((sum, group) => sum + group.totalAmount, 0),
    paidAmount: groups.reduce((sum, group) => sum + group.paidAmount, 0),
    pendingAmount: groups.reduce((sum, group) => sum + group.pendingAmount, 0),
    paidCount: groups.reduce((sum, group) => sum + group.paidCount, 0),
    pendingCount: groups.reduce((sum, group) => sum + group.pendingCount, 0),
    memberCount: rows.length,
  };
}

/**
 * Marca o desmarca el pago de un miembro desde el tablero.
 *
 * Es un atajo de un gesto sobre las operaciones de siempre: marcar crea el pago
 * por el importe calculado, desmarcar lo anula. No es un simple color guardado
 * aparte —eso dejaría dos versiones de la verdad—, así que hereda todo lo que
 * ya protege a un pago: período cerrado, una liquidación vigente por persona,
 * y asiento en la auditoría con quién y cuándo.
 */
export async function togglePaymentFromBoard(
  input: { readonly weekId: string; readonly staffMemberId: string; readonly paid: boolean },
  actor: ActorContext,
): Promise<{ paid: boolean; name: string; amount: number }> {
  const [current] = await db
    .select({
      paymentId: payments.id,
      version: payments.version,
      amount: payments.amount,
      name: weeklyStaffRecords.staffNameSnapshot,
      calculated: weeklyStaffRecords.calculatedAmount,
    })
    .from(weeklyStaffRecords)
    .leftJoin(
      payments,
      and(
        eq(payments.weekId, weeklyStaffRecords.weekId),
        eq(payments.staffMemberId, weeklyStaffRecords.staffMemberId),
        isNull(payments.voidedAt),
      ),
    )
    .where(
      and(
        eq(weeklyStaffRecords.weekId, input.weekId),
        eq(weeklyStaffRecords.staffMemberId, input.staffMemberId),
      ),
    )
    .limit(1);

  if (!current) throw notFound("La liquidación de ese miembro en este período");

  if (input.paid) {
    if (current.paymentId) {
      return { paid: true, name: current.name, amount: current.amount ?? 0 };
    }

    await createPayment(
      {
        weekId: input.weekId,
        staffMemberId: input.staffMemberId,
        expectedAmount: current.calculated,
        method: "in_game",
        paymentReference: null,
        notes: "Marcado como pagado desde el tablero de pagos.",
        /**
         * Clave nueva en cada marcado. Reutilizar una clave fija por persona y
         * período parecería más prolijo, pero después de desmarcar y volver a
         * marcar devolvería el pago ya anulado en lugar de registrar el nuevo.
         * Contra el doble click alcanza el índice único parcial de la base.
         */
        idempotencyKey: randomUUID().replaceAll("-", ""),
        allowAmountMismatch: false,
        mismatchReason: null,
      },
      actor,
      true,
    );

    return { paid: true, name: current.name, amount: current.calculated };
  }

  if (!current.paymentId || current.version === null) {
    return { paid: false, name: current.name, amount: current.calculated };
  }

  await voidPayment(
    {
      id: current.paymentId,
      expectedVersion: current.version,
      reason: "Desmarcado desde el tablero de pagos: vuelve a figurar como pendiente.",
      confirmation: "ANULAR",
    },
    actor,
  );

  return { paid: false, name: current.name, amount: current.calculated };
}
