import { and, asc, desc, eq, gte, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db, withTransaction, type Transaction } from "@/db";
import { hourEntries, staffMembers, weeklyStaffRecords, weeks, type HourEntry } from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import { businessRule, concurrency, notFound, validation } from "@/lib/core/errors";
import { isDateWithinPeriod, formatCalendarDate, formatPeriodLabel } from "@/domain/periods";
import { formatMinutes, MAX_MINUTES_PER_WEEK } from "@/domain/time";
import { containsPattern, offsetFor, paginate, type Paginated } from "@/validation/common";
import type {
  BulkHourEntriesInput,
  CreateHourEntryInput,
  HourFilters,
  UpdateHourEntryInput,
  VoidHourEntryInput,
} from "@/validation/hours";
import { appendAuditLog } from "./audit";
import { loadWeekForWrite, recalculateWeekRecords } from "./weeks";
/**
 * IMPERIO RP — Registro de horas.
 *
 * Cada entrada individual se conserva: el total semanal nunca es un número
 * suelto, es la suma de turnos concretos con fecha, motivo y responsable. Eso
 * permite responder "¿de dónde salieron estas 18 h 30 m?" con el detalle exacto,
 * incluso años después.
 *
 * Las entradas no se borran: se anulan. Una hora cargada por error y corregida
 * deja el rastro de ambos hechos.
 */
export interface HourEntryView {
  readonly id: string;
  readonly staffMemberId: string;
  readonly staffName: string;
  readonly staffRank: string;
  readonly weekId: string;
  readonly weekCode: string;
  readonly workDate: string;
  readonly minutes: number;
  readonly reason: string;
  readonly recordedByUsername: string;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
const entrySelect = {
  id: hourEntries.id,
  staffMemberId: hourEntries.staffMemberId,
  staffName: staffMembers.name,
  staffRank: staffMembers.rank,
  weekId: hourEntries.weekId,
  weekCode: weeks.code,
  workDate: hourEntries.workDate,
  minutes: hourEntries.minutes,
  reason: hourEntries.reason,
  recordedByUsername: hourEntries.recordedByUsername,
  voidedAt: hourEntries.voidedAt,
  voidReason: hourEntries.voidReason,
  version: hourEntries.version,
  createdAt: hourEntries.createdAt,
  updatedAt: hourEntries.updatedAt,
} as const;
/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */
export async function listHourEntries(filters: HourFilters): Promise<Paginated<HourEntryView>> {
  const conditions: SQL[] = [];
  if (filters.weekId) conditions.push(eq(hourEntries.weekId, filters.weekId));
  if (filters.staffMemberId) conditions.push(eq(hourEntries.staffMemberId, filters.staffMemberId));
  if (!filters.includeVoided) conditions.push(isNull(hourEntries.voidedAt));
  if (filters.from) conditions.push(gte(hourEntries.workDate, filters.from));
  if (filters.to) conditions.push(lte(hourEntries.workDate, filters.to));
  if (filters.search) {
    const pattern = containsPattern(filters.search);
    const matches = or(
      sql`${staffMembers.name} ilike ${pattern}`,
      sql`${hourEntries.reason} ilike ${pattern}`,
      sql`${hourEntries.recordedByUsername} ilike ${pattern}`,
    );
    if (matches) conditions.push(matches);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const direction = filters.sortDir === "asc" ? asc : desc;
  const orderBy = (() => {
    switch (filters.sortBy) {
      case "minutes":
        return [direction(hourEntries.minutes)];
      case "createdAt":
        return [direction(hourEntries.createdAt)];
      case "staffName":
        return [direction(staffMembers.name), desc(hourEntries.workDate)];
      default:
        return [direction(hourEntries.workDate), desc(hourEntries.createdAt)];
    }
  })();
  const [items, [countRow]] = await Promise.all([
    db
      .select(entrySelect)
      .from(hourEntries)
      .innerJoin(staffMembers, eq(hourEntries.staffMemberId, staffMembers.id))
      .innerJoin(weeks, eq(hourEntries.weekId, weeks.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(hourEntries)
      .innerJoin(staffMembers, eq(hourEntries.staffMemberId, staffMembers.id))
      .where(where),
  ]);
  return paginate(items, countRow?.value ?? 0, filters);
}
/**
 * Desglose de un miembro en un período: las entradas que explican su total.
 * Es la respuesta a "¿de dónde salieron estas horas?".
 */
export async function getStaffWeekBreakdown(
  staffMemberId: string,
  weekId: string,
  includeVoided = false,
): Promise<{
  entries: readonly HourEntryView[];
  totalMinutes: number;
  voidedMinutes: number;
}> {
  const conditions: SQL[] = [
    eq(hourEntries.staffMemberId, staffMemberId),
    eq(hourEntries.weekId, weekId),
  ];
  if (!includeVoided) conditions.push(isNull(hourEntries.voidedAt));
  const entries = await db
    .select(entrySelect)
    .from(hourEntries)
    .innerJoin(staffMembers, eq(hourEntries.staffMemberId, staffMembers.id))
    .innerJoin(weeks, eq(hourEntries.weekId, weeks.id))
    .where(and(...conditions))
    .orderBy(asc(hourEntries.workDate), asc(hourEntries.createdAt));
  return {
    entries,
    totalMinutes: entries
      .filter((entry) => entry.voidedAt === null)
      .reduce((sum, entry) => sum + entry.minutes, 0),
    voidedMinutes: entries
      .filter((entry) => entry.voidedAt !== null)
      .reduce((sum, entry) => sum + entry.minutes, 0),
  };
}
export async function getHourEntry(id: string): Promise<HourEntry | null> {
  const [entry] = await db.select().from(hourEntries).where(eq(hourEntries.id, id)).limit(1);
  return entry ?? null;
}
/** Actividad reciente para el panel de inicio. */
export async function listRecentHourEntries(limit = 8): Promise<HourEntryView[]> {
  return db
    .select(entrySelect)
    .from(hourEntries)
    .innerJoin(staffMembers, eq(hourEntries.staffMemberId, staffMembers.id))
    .innerJoin(weeks, eq(hourEntries.weekId, weeks.id))
    .where(isNull(hourEntries.voidedAt))
    .orderBy(desc(hourEntries.createdAt))
    .limit(limit);
}
/** Horas por día de un período. Alimenta el gráfico de actividad. */
export async function getDailyMinutes(
  weekId: string,
): Promise<{ workDate: string; minutes: number; entries: number }[]> {
  return db
    .select({
      workDate: hourEntries.workDate,
      minutes: sql<number>`sum(${hourEntries.minutes})::int`,
      entries: sql<number>`count(*)::int`,
    })
    .from(hourEntries)
    .where(and(eq(hourEntries.weekId, weekId), isNull(hourEntries.voidedAt)))
    .groupBy(hourEntries.workDate)
    .orderBy(asc(hourEntries.workDate));
}
/* -------------------------------------------------------------------------- */
/* Escrituras                                                                 */
/* -------------------------------------------------------------------------- */
function entryAuditView(entry: HourEntry, staffName?: string) {
  return {
    ...(staffName ? { miembro: staffName } : {}),
    fecha: entry.workDate,
    minutos: entry.minutes,
    duracion: formatMinutes(entry.minutes),
    motivo: entry.reason,
    registradoPor: entry.recordedByUsername,
  };
}
/**
 * Comprueba que la fecha del turno caiga dentro del período.
 *
 * Se permite igualmente, con advertencia previa en la pantalla de cierre,
 * porque a veces hay correcciones legítimas de un día limítrofe. Lo que no se
 * permite es que pase inadvertido.
 */
function assertDateWithinWeek(workDate: string, week: { startDate: string; endDate: string }) {
  if (!isDateWithinPeriod(workDate, week.startDate, week.endDate)) {
    throw validation("La fecha está fuera del período.", {
      workDate: [
        "El " +
          formatCalendarDate(workDate) +
          " no pertenece a " +
          formatPeriodLabel(week.startDate, week.endDate) +
          ".",
      ],
    });
  }
}
/** Impide que el total semanal de una persona supere las horas que tiene una semana. */
async function assertWeeklyCeiling(
  tx: Transaction,
  staffMemberId: string,
  weekId: string,
  additionalMinutes: number,
  excludeEntryId?: string,
): Promise<void> {
  const conditions: SQL[] = [
    eq(hourEntries.staffMemberId, staffMemberId),
    eq(hourEntries.weekId, weekId),
    isNull(hourEntries.voidedAt),
  ];
  if (excludeEntryId) conditions.push(sql`${hourEntries.id} <> ${excludeEntryId}`);
  const [current] = await tx
    .select({ total: sql<number>`coalesce(sum(${hourEntries.minutes}), 0)::int` })
    .from(hourEntries)
    .where(and(...conditions));
  const projected = (current?.total ?? 0) + additionalMinutes;
  if (projected > MAX_MINUTES_PER_WEEK) {
    throw businessRule(
      "El total del período quedaría en " +
        formatMinutes(projected) +
        ", más que las 168 horas que tiene una semana. Revisá las entradas cargadas.",
    );
  }
}
export async function createHourEntry(
  input: CreateHourEntryInput,
  actor: ActorContext,
): Promise<HourEntry> {
  return withTransaction(async (tx) => {
    const week = await loadWeekForWrite(tx, input.weekId);
    assertDateWithinWeek(input.workDate, week);
    const [member] = await tx
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.id, input.staffMemberId))
      .limit(1);
    if (!member) throw notFound("El miembro del staff");
    if (member.archivedAt) {
      throw businessRule(member.name + " está archivado. Reincorporalo antes de cargarle horas.");
    }
    await assertWeeklyCeiling(tx, input.staffMemberId, input.weekId, input.totalMinutes);
    const [entry] = await tx
      .insert(hourEntries)
      .values({
        staffMemberId: input.staffMemberId,
        weekId: input.weekId,
        workDate: input.workDate,
        minutes: input.totalMinutes,
        reason: input.reason,
        recordedBy: actor.id,
        recordedByUsername: actor.username,
      })
      .returning();
    if (!entry) throw new Error("No se pudo registrar la entrada de horas.");
    await recalculateWeekRecords(tx, input.weekId);
    await appendAuditLog(tx, {
      actor,
      action: "HOURS_LOGGED",
      entity: "hour_entries",
      entityId: entry.id,
      summary:
        "Registró " +
        formatMinutes(entry.minutes) +
        " a " +
        member.name +
        " (" +
        formatCalendarDate(entry.workDate) +
        ")",
      after: entryAuditView(entry, member.name),
      metadata: { weekId: input.weekId, staffMemberId: member.id },
    });
    return entry;
  });
}
/**
 * Carga varias entradas de una sola vez. Todo o nada: si una fila falla, no se
 * guarda ninguna, para que nadie quede con media planilla cargada sin saber
 * cuáles entraron.
 */
export async function createBulkHourEntries(
  input: BulkHourEntriesInput,
  actor: ActorContext,
): Promise<{ created: number; totalMinutes: number }> {
  return withTransaction(async (tx) => {
    const week = await loadWeekForWrite(tx, input.weekId);
    assertDateWithinWeek(input.workDate, week);
    const applicable = input.entries.filter((entry) => entry.hours * 60 + entry.minutes > 0);
    if (applicable.length === 0) {
      throw validation("No cargaste horas en ningún miembro.", {
        entries: ["Poné al menos una duración mayor a cero."],
      });
    }
    const uniqueIds = new Set(applicable.map((entry) => entry.staffMemberId));
    if (uniqueIds.size !== applicable.length) {
      throw validation("Hay miembros repetidos en la carga.", {
        entries: ["Cada miembro puede aparecer una sola vez."],
      });
    }
    const members = await tx
      .select({ id: staffMembers.id, name: staffMembers.name, archivedAt: staffMembers.archivedAt })
      .from(staffMembers)
      .where(sql`${staffMembers.id} in ${[...uniqueIds]}`);
    const byId = new Map(members.map((member) => [member.id, member]));
    for (const entry of applicable) {
      const member = byId.get(entry.staffMemberId);
      if (!member) throw notFound("Un miembro del staff seleccionado");
      if (member.archivedAt) {
        throw businessRule(member.name + " está archivado y no puede recibir horas.");
      }
      await assertWeeklyCeiling(
        tx,
        entry.staffMemberId,
        input.weekId,
        entry.hours * 60 + entry.minutes,
      );
    }
    const inserted = await tx
      .insert(hourEntries)
      .values(
        applicable.map((entry) => ({
          staffMemberId: entry.staffMemberId,
          weekId: input.weekId,
          workDate: input.workDate,
          minutes: entry.hours * 60 + entry.minutes,
          reason: input.reason,
          recordedBy: actor.id,
          recordedByUsername: actor.username,
        })),
      )
      .returning();
    await recalculateWeekRecords(tx, input.weekId);
    const totalMinutes = inserted.reduce((sum, entry) => sum + entry.minutes, 0);
    await appendAuditLog(tx, {
      actor,
      action: "HOURS_BULK_LOGGED",
      entity: "hour_entries",
      entityId: input.weekId,
      summary:
        "Registró " +
        formatMinutes(totalMinutes) +
        " repartidas entre " +
        inserted.length +
        " miembros (" +
        formatCalendarDate(input.workDate) +
        ")",
      after: {
        fecha: input.workDate,
        motivo: input.reason,
        detalle: inserted.map((entry) => ({
          miembro: byId.get(entry.staffMemberId)?.name ?? entry.staffMemberId,
          duracion: formatMinutes(entry.minutes),
        })),
      },
      metadata: { weekId: input.weekId, cantidad: inserted.length },
    });
    return { created: inserted.length, totalMinutes };
  });
}
/**
 * Corrige una entrada existente.
 *
 * El antes, el después, el motivo, quién y cuándo quedan en la auditoría. Es
 * exactamente la información que hace falta para responder "¿por qué a Martin
 * le figuraban 16 h 30 m y ahora 18 h 30 m?".
 */
export async function updateHourEntry(
  input: UpdateHourEntryInput,
  actor: ActorContext,
): Promise<HourEntry> {
  return withTransaction(async (tx) => {
    const existing = await lockEntry(tx, input.id);
    if (existing.voidedAt) {
      throw businessRule("La entrada está anulada. No se puede modificar.");
    }
    const week = await loadWeekForWrite(tx, existing.weekId);
    assertDateWithinWeek(input.workDate, week);
    await assertWeeklyCeiling(
      tx,
      existing.staffMemberId,
      existing.weekId,
      input.totalMinutes,
      existing.id,
    );
    const [member] = await tx
      .select({ name: staffMembers.name })
      .from(staffMembers)
      .where(eq(staffMembers.id, existing.staffMemberId))
      .limit(1);
    const [updated] = await tx
      .update(hourEntries)
      .set({
        workDate: input.workDate,
        minutes: input.totalMinutes,
        reason: input.reason,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(hourEntries.id, input.id), eq(hourEntries.version, input.expectedVersion)))
      .returning();
    if (!updated) throw concurrency();
    await recalculateWeekRecords(tx, existing.weekId);
    await appendAuditLog(tx, {
      actor,
      action: "HOURS_UPDATED",
      entity: "hour_entries",
      entityId: updated.id,
      summary:
        "Modificó las horas de " +
        (member?.name ?? "un miembro") +
        ": " +
        formatMinutes(existing.minutes) +
        " → " +
        formatMinutes(updated.minutes),
      before: entryAuditView(existing, member?.name),
      after: entryAuditView(updated, member?.name),
      reason: input.changeReason,
      metadata: { weekId: existing.weekId, staffMemberId: existing.staffMemberId },
    });
    return updated;
  });
}
/**
 * Anula una entrada. No la borra: la marca como anulada con motivo y
 * responsable, y la deja de contar en los totales.
 */
export async function voidHourEntry(
  input: VoidHourEntryInput,
  actor: ActorContext,
): Promise<HourEntry> {
  return withTransaction(async (tx) => {
    const existing = await lockEntry(tx, input.id);
    if (existing.voidedAt) {
      throw businessRule("La entrada ya está anulada.");
    }
    await loadWeekForWrite(tx, existing.weekId);
    const [member] = await tx
      .select({ name: staffMembers.name })
      .from(staffMembers)
      .where(eq(staffMembers.id, existing.staffMemberId))
      .limit(1);
    const [voided] = await tx
      .update(hourEntries)
      .set({
        voidedAt: new Date(),
        voidedBy: actor.id,
        voidReason: input.reason,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(hourEntries.id, input.id), eq(hourEntries.version, input.expectedVersion)))
      .returning();
    if (!voided) throw concurrency();
    await recalculateWeekRecords(tx, existing.weekId);
    await appendAuditLog(tx, {
      actor,
      action: "HOURS_VOIDED",
      entity: "hour_entries",
      entityId: voided.id,
      summary:
        "Anuló " +
        formatMinutes(existing.minutes) +
        " de " +
        (member?.name ?? "un miembro") +
        " (" +
        formatCalendarDate(existing.workDate) +
        ")",
      before: entryAuditView(existing, member?.name),
      after: { anulada: true, motivo: input.reason },
      reason: input.reason,
      metadata: { weekId: existing.weekId, staffMemberId: existing.staffMemberId },
    });
    return voided;
  });
}
async function lockEntry(tx: Transaction, id: string): Promise<HourEntry> {
  const [entry] = await tx
    .select()
    .from(hourEntries)
    .where(eq(hourEntries.id, id))
    .limit(1)
    .for("update");
  if (!entry) throw notFound("La entrada de horas");
  return entry;
}
/* -------------------------------------------------------------------------- */
/* Vista de liquidación                                                       */
/* -------------------------------------------------------------------------- */
export interface WeeklyLine {
  readonly recordId: string;
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly category: string;
  readonly hourlyRate: number;
  readonly totalMinutes: number;
  readonly amount: number;
  readonly entryCount: number;
  readonly frozenAt: Date | null;
  readonly version: number;
}
/**
 * Liquidación del período: una línea por miembro, siempre leída del snapshot.
 *
 * Para un período cerrado esto devuelve exactamente lo que se congeló ese día,
 * sin recalcular nada con datos actuales.
 */
export async function getWeeklyLines(weekId: string): Promise<WeeklyLine[]> {
  return db
    .select({
      recordId: weeklyStaffRecords.id,
      staffMemberId: weeklyStaffRecords.staffMemberId,
      name: weeklyStaffRecords.staffNameSnapshot,
      rank: weeklyStaffRecords.rankSnapshot,
      category: weeklyStaffRecords.categorySnapshot,
      hourlyRate: weeklyStaffRecords.hourlyRateSnapshot,
      totalMinutes: weeklyStaffRecords.totalMinutes,
      amount: weeklyStaffRecords.calculatedAmount,
      entryCount: weeklyStaffRecords.entryCount,
      frozenAt: weeklyStaffRecords.frozenAt,
      version: weeklyStaffRecords.version,
    })
    .from(weeklyStaffRecords)
    .where(eq(weeklyStaffRecords.weekId, weekId))
    .orderBy(desc(weeklyStaffRecords.totalMinutes), asc(weeklyStaffRecords.staffNameSnapshot));
}
/** Todos los períodos en los que participó un miembro. Alimenta su ficha. */
export async function getStaffHistory(
  staffMemberId: string,
  limit = 26,
): Promise<
  {
    weekId: string;
    code: string;
    startDate: string;
    endDate: string;
    status: string;
    rank: string;
    hourlyRate: number;
    totalMinutes: number;
    amount: number;
  }[]
> {
  return db
    .select({
      weekId: weeks.id,
      code: weeks.code,
      startDate: weeks.startDate,
      endDate: weeks.endDate,
      status: weeks.status,
      rank: weeklyStaffRecords.rankSnapshot,
      hourlyRate: weeklyStaffRecords.hourlyRateSnapshot,
      totalMinutes: weeklyStaffRecords.totalMinutes,
      amount: weeklyStaffRecords.calculatedAmount,
    })
    .from(weeklyStaffRecords)
    .innerJoin(weeks, eq(weeklyStaffRecords.weekId, weeks.id))
    .where(eq(weeklyStaffRecords.staffMemberId, staffMemberId))
    .orderBy(desc(weeks.startDate))
    .limit(limit);
}
