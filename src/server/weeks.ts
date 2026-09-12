import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db, withTransaction, type Executor, type Transaction } from "@/db";
import {
  hourEntries,
  payments,
  staffMembers,
  weeklyStaffRecords,
  weeks,
  type Week,
} from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import {
  businessRule,
  concurrency,
  conflict,
  isUniqueViolation,
  notFound,
} from "@/lib/core/errors";
import { formatMoney } from "@/domain/money";
import {
  buildPeriodCode,
  formatPeriodLabel,
  periodLengthInDays,
  periodsOverlap,
  suggestNextPeriod,
  type CalendarDate,
} from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import { offsetFor, paginate, type Paginated } from "@/validation/common";
import type {
  CloseWeekInput,
  CreateWeekInput,
  ReopenWeekInput,
  UpdateWeekInput,
  WeekFilters,
} from "@/validation/weeks";
import { appendAuditLog } from "./audit";
/**
 * IMPERIO RP — Períodos de liquidación.
 *
 * Acá vive la regla que sostiene todo el sistema: al cerrar un período, cada
 * miembro queda con un registro que copia su nombre, su rango, su tarifa y su
 * importe TAL COMO ERAN ESE DÍA. A partir de ese momento nada de lo que ocurra
 * después — un ascenso, un ajuste de tarifa, un cambio de nombre — puede
 * alterar ni un peso de esa liquidación.
 */
/* -------------------------------------------------------------------------- */
/* Recálculo de snapshots                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Recalcula los registros semanales de un período ABIERTO en una sola sentencia.
 *
 * Se resuelve íntegramente dentro de PostgreSQL por tres motivos: es atómico,
 * no hay una ventana en la que los totales estén a medio actualizar, y no
 * depende de traer miles de filas al proceso de Node.
 *
 * El importe usa la misma aritmética entera que `calculateEarnings` en
 * TypeScript — `(minutos × tarifa × 2 + 60) / 120` es exactamente el redondeo
 * half-up de `minutos × tarifa / 60`. Un test compara ambas implementaciones
 * sobre miles de combinaciones para que no puedan divergir.
 *
 * La cláusula final `where frozen_at is null` es la red de seguridad: aunque
 * un error de programación llamara a esta función sobre un período cerrado, las
 * filas congeladas no se tocan.
 */
export async function recalculateWeekRecords(tx: Transaction, weekId: string): Promise<void> {
  await tx.execute(sql`
    insert into weekly_staff_records (
      week_id, staff_member_id, staff_name_snapshot, rank_snapshot, category_snapshot,
      hourly_rate_snapshot, total_minutes, calculated_amount, entry_count
    )
    select
      ${weekId}::uuid,
      s.id,
      s.name,
      s.rank,
      s.category,
      r.rate_per_hour,
      coalesce(h.total_minutes, 0),
      ((coalesce(h.total_minutes, 0)::bigint * r.rate_per_hour::bigint * 2 + 60) / 120)::bigint,
      coalesce(h.entry_count, 0)
    from staff_members s
    join rank_rates r on r.rank = s.rank
    left join lateral (
      select sum(he.minutes)::int as total_minutes, count(*)::int as entry_count
      from hour_entries he
      where he.staff_member_id = s.id
        and he.week_id = ${weekId}::uuid
        and he.voided_at is null
        -- Un día inactivo, justificado o anulado no suma horas ni se paga.
        and he.status = 'normal'
    ) h on true
    where h.total_minutes is not null
       or exists (
         select 1 from weekly_staff_records w
         where w.week_id = ${weekId}::uuid and w.staff_member_id = s.id
       )
    on conflict (week_id, staff_member_id) do update set
      staff_name_snapshot   = excluded.staff_name_snapshot,
      rank_snapshot         = excluded.rank_snapshot,
      category_snapshot     = excluded.category_snapshot,
      hourly_rate_snapshot  = excluded.hourly_rate_snapshot,
      total_minutes         = excluded.total_minutes,
      calculated_amount     = excluded.calculated_amount,
      entry_count           = excluded.entry_count,
      version               = weekly_staff_records.version + 1,
      updated_at            = now()
    where weekly_staff_records.frozen_at is null
  `);
}
/** Recalcula todos los períodos abiertos. Se usa al cambiar un rango o una tarifa. */
export async function recalculateAllOpenWeeks(tx: Transaction): Promise<number> {
  const openWeeks = await tx.select({ id: weeks.id }).from(weeks).where(eq(weeks.status, "open"));
  for (const week of openWeeks) {
    await recalculateWeekRecords(tx, week.id);
  }
  return openWeeks.length;
}
/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */
export interface WeekListItem {
  readonly id: string;
  readonly code: string;
  readonly label: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly version: number;
  readonly closedAt: Date | null;
  readonly reopenCount: number;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly memberCount: number;
  readonly paidCount: number;
  readonly paidAmount: number;
}
/**
 * Totales por período. Para los cerrados se leen los valores congelados; para
 * los abiertos se agregan en vivo.
 */
const weekTotalsSelect = {
  totalMinutes: sql<number>`coalesce(${weeks.frozenTotalMinutes}, (
    select coalesce(sum(w.total_minutes), 0)::int from weekly_staff_records w where w.week_id = ${weeks.id}
  ))`,
  totalAmount: sql<number>`coalesce(${weeks.frozenTotalAmount}, (
    select coalesce(sum(w.calculated_amount), 0)::bigint from weekly_staff_records w where w.week_id = ${weeks.id}
  ))::bigint`,
  memberCount: sql<number>`coalesce(${weeks.frozenMemberCount}, (
    select count(*)::int from weekly_staff_records w where w.week_id = ${weeks.id}
  ))`,
  paidCount: sql<number>`(
    select count(*)::int from payments p where p.week_id = ${weeks.id} and p.voided_at is null
  )`,
  paidAmount: sql<number>`(
    select coalesce(sum(p.amount), 0)::bigint from payments p where p.week_id = ${weeks.id} and p.voided_at is null
  )::bigint`,
} as const;
export async function listWeeks(filters: WeekFilters): Promise<Paginated<WeekListItem>> {
  const conditions: SQL[] = [];
  if (filters.status !== "all") conditions.push(eq(weeks.status, filters.status));
  if (filters.year) {
    conditions.push(sql`extract(year from ${weeks.startDate}) = ${filters.year}`);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, [countRow]] = await Promise.all([
    db
      .select({
        id: weeks.id,
        code: weeks.code,
        label: weeks.label,
        startDate: weeks.startDate,
        endDate: weeks.endDate,
        status: weeks.status,
        version: weeks.version,
        closedAt: weeks.closedAt,
        reopenCount: weeks.reopenCount,
        ...weekTotalsSelect,
      })
      .from(weeks)
      .where(where)
      .orderBy(filters.sortDir === "asc" ? asc(weeks.startDate) : desc(weeks.startDate))
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(weeks)
      .where(where),
  ]);
  return paginate(items, countRow?.value ?? 0, filters);
}
export async function getWeek(id: string): Promise<Week | null> {
  const [week] = await db.select().from(weeks).where(eq(weeks.id, id)).limit(1);
  return week ?? null;
}
export async function requireWeek(id: string): Promise<Week> {
  const week = await getWeek(id);
  if (!week) throw notFound("El período");
  return week;
}
/** Período abierto más reciente. Es el contexto por defecto de toda la app. */
export async function getCurrentWeek(): Promise<Week | null> {
  const [week] = await db
    .select()
    .from(weeks)
    .where(eq(weeks.status, "open"))
    .orderBy(desc(weeks.startDate))
    .limit(1);
  return week ?? null;
}
export async function listWeekOptions(limit = 60): Promise<
  {
    id: string;
    code: string;
    label: string | null;
    startDate: string;
    endDate: string;
    status: string;
  }[]
> {
  return db
    .select({
      id: weeks.id,
      code: weeks.code,
      label: weeks.label,
      startDate: weeks.startDate,
      endDate: weeks.endDate,
      status: weeks.status,
    })
    .from(weeks)
    .orderBy(desc(weeks.startDate))
    .limit(limit);
}
export interface WeekDetail extends WeekListItem {
  readonly notes: string | null;
  readonly reopenReason: string | null;
  readonly reopenedAt: Date | null;
  readonly createdAt: Date;
}
export async function getWeekDetail(id: string): Promise<WeekDetail | null> {
  const [row] = await db
    .select({
      id: weeks.id,
      code: weeks.code,
      label: weeks.label,
      startDate: weeks.startDate,
      endDate: weeks.endDate,
      status: weeks.status,
      version: weeks.version,
      closedAt: weeks.closedAt,
      reopenCount: weeks.reopenCount,
      notes: weeks.notes,
      reopenReason: weeks.reopenReason,
      reopenedAt: weeks.reopenedAt,
      createdAt: weeks.createdAt,
      ...weekTotalsSelect,
    })
    .from(weeks)
    .where(eq(weeks.id, id))
    .limit(1);
  return row ?? null;
}
/** Sugiere el siguiente período a partir del último registrado. */
export async function suggestNextPeriodRange(): Promise<{
  startDate: CalendarDate;
  endDate: CalendarDate;
}> {
  const [last] = await db
    .select({ startDate: weeks.startDate, endDate: weeks.endDate })
    .from(weeks)
    .orderBy(desc(weeks.endDate))
    .limit(1);
  if (!last) {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    return { startDate: today, endDate: end };
  }
  return suggestNextPeriod({ startDate: last.startDate, endDate: last.endDate });
}
/* -------------------------------------------------------------------------- */
/* Creación y edición                                                         */
/* -------------------------------------------------------------------------- */
export async function createWeek(input: CreateWeekInput, actor: ActorContext): Promise<Week> {
  const code = buildPeriodCode(input.startDate, input.endDate);
  return withTransaction(async (tx) => {
    /**
     * Un período no puede pisar a otro: si dos abarcaran el mismo día, no
     * habría forma de decidir a cuál pertenece una hora cargada ese día.
     */
    const existing = await tx
      .select({
        id: weeks.id,
        code: weeks.code,
        startDate: weeks.startDate,
        endDate: weeks.endDate,
      })
      .from(weeks);
    const overlapping = existing.find((week) =>
      periodsOverlap(
        { startDate: input.startDate, endDate: input.endDate },
        { startDate: week.startDate, endDate: week.endDate },
      ),
    );
    if (overlapping) {
      /**
       * El mensaje nombra los días exactos que chocan. Decir sólo "se
       * superpone" obliga a adivinar contra qué, y con varios períodos
       * cargados es imposible: las fechas se ven distintas y aun así comparten
       * un día en el medio.
       */
      const desde =
        input.startDate > overlapping.startDate ? input.startDate : overlapping.startDate;
      const hasta = input.endDate < overlapping.endDate ? input.endDate : overlapping.endDate;

      throw conflict(
        "El período que querés crear (" +
          input.startDate +
          " → " +
          input.endDate +
          ") comparte " +
          (desde === hasta ? "el día " + desde : "los días " + desde + " → " + hasta) +
          " con " +
          formatPeriodLabel(overlapping.startDate, overlapping.endDate) +
          " (" +
          overlapping.startDate +
          " → " +
          overlapping.endDate +
          "). Elegí fechas que no pisen ningún día de ese período.",
      );
    }
    let created;
    try {
      [created] = await tx
        .insert(weeks)
        .values({
          code,
          label: input.label,
          startDate: input.startDate,
          endDate: input.endDate,
          notes: input.notes,
          status: "open",
          createdBy: actor.id,
        })
        .returning();
    } catch (error) {
      /**
       * Último cerrojo.
       *
       * El chequeo de arriba mira las FECHAS; el índice único mira el CÓDIGO.
       * Con la restricción que ata uno a otro no deberían poder discrepar, pero
       * si alguna vez discrepan, esto convierte un error incomprensible en algo
       * que se entiende y se puede reportar.
       */
      if (isUniqueViolation(error)) {
        throw conflict(
          "Ya existe un período con esas fechas. Si no aparece en la lista, avisale a pit o mati: " +
            "quedó algo inconsistente en la base.",
        );
      }
      throw error;
    }
    if (!created) throw new Error("No se pudo crear el período.");
    /**
     * Sembrar el período con los miembros activos y cero horas hace que nadie
     * quede afuera de la liquidación por olvido, y que la lista de pendientes
     * sea completa desde el primer día.
     */
    if (input.seedActiveStaff) {
      await tx.execute(sql`
        insert into weekly_staff_records (
          week_id, staff_member_id, staff_name_snapshot, rank_snapshot, category_snapshot,
          hourly_rate_snapshot, total_minutes, calculated_amount, entry_count
        )
        select ${created.id}::uuid, s.id, s.name, s.rank, s.category, r.rate_per_hour, 0, 0, 0
        from staff_members s
        join rank_rates r on r.rank = s.rank
        where s.active = true and s.archived_at is null
        on conflict (week_id, staff_member_id) do nothing
      `);
    }
    await appendAuditLog(tx, {
      actor,
      action: "WEEK_CREATED",
      entity: "weeks",
      entityId: created.id,
      summary: "Abrió el período " + formatPeriodLabel(created.startDate, created.endDate),
      after: {
        codigo: created.code,
        inicio: created.startDate,
        fin: created.endDate,
        etiqueta: created.label,
        dias: periodLengthInDays(created.startDate, created.endDate),
      },
    });
    return created;
  });
}
export async function updateWeek(input: UpdateWeekInput, actor: ActorContext): Promise<Week> {
  return withTransaction(async (tx) => {
    const existing = await lockWeek(tx, input.id);
    const [updated] = await tx
      .update(weeks)
      .set({
        label: input.label,
        notes: input.notes,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(weeks.id, input.id), eq(weeks.version, input.expectedVersion)))
      .returning();
    if (!updated) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "WEEK_UPDATED",
      entity: "weeks",
      entityId: updated.id,
      summary: "Editó el período " + formatPeriodLabel(updated.startDate, updated.endDate),
      before: { etiqueta: existing.label, notas: existing.notes },
      after: { etiqueta: updated.label, notas: updated.notes },
    });
    return updated;
  });
}
/** Incorpora a un miembro que no estaba en el período. */
export async function addMemberToWeek(
  weekId: string,
  staffMemberId: string,
  actor: ActorContext,
): Promise<void> {
  await withTransaction(async (tx) => {
    const week = await lockWeek(tx, weekId);
    assertWeekOpen(week);
    const [member] = await tx
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.id, staffMemberId))
      .limit(1);
    if (!member) throw notFound("El miembro del staff");
    if (member.archivedAt) {
      throw businessRule("No se puede agregar un miembro archivado a un período.");
    }
    await tx.execute(sql`
      insert into weekly_staff_records (
        week_id, staff_member_id, staff_name_snapshot, rank_snapshot, category_snapshot,
        hourly_rate_snapshot, total_minutes, calculated_amount, entry_count
      )
      select ${weekId}::uuid, s.id, s.name, s.rank, s.category, r.rate_per_hour, 0, 0, 0
      from staff_members s
      join rank_rates r on r.rank = s.rank
      where s.id = ${staffMemberId}::uuid
      on conflict (week_id, staff_member_id) do nothing
    `);
    await recalculateWeekRecords(tx, weekId);
    await appendAuditLog(tx, {
      actor,
      action: "WEEK_MEMBER_ADDED",
      entity: "weeks",
      entityId: weekId,
      summary: "Agregó a " + member.name + " al período " + week.code,
      after: { miembro: member.name, rango: member.rank },
    });
  });
}
/* -------------------------------------------------------------------------- */
/* Cierre                                                                     */
/* -------------------------------------------------------------------------- */
export interface CloseWarning {
  readonly kind: "sin-horas" | "horas-altas" | "fuera-de-rango" | "sin-miembros" | "pago-desfasado";
  readonly message: string;
}
export interface ClosePreflight {
  readonly canClose: boolean;
  readonly warnings: readonly CloseWarning[];
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly memberCount: number;
  readonly membersWithHours: number;
}
/**
 * Revisión previa al cierre. No bloquea: informa.
 *
 * La idea es que nadie cierre un período con un "22" tipeado donde iba un "2",
 * ni con la mitad del staff en cero porque se olvidaron de cargar el domingo.
 */
export async function preflightClose(weekId: string): Promise<ClosePreflight> {
  const week = await requireWeek(weekId);
  const warnings: CloseWarning[] = [];
  const records = await db
    .select({
      name: weeklyStaffRecords.staffNameSnapshot,
      minutes: weeklyStaffRecords.totalMinutes,
      amount: weeklyStaffRecords.calculatedAmount,
    })
    .from(weeklyStaffRecords)
    .where(eq(weeklyStaffRecords.weekId, weekId));
  if (records.length === 0) {
    warnings.push({
      kind: "sin-miembros",
      message: "El período no tiene ningún miembro cargado. Se cerrará vacío.",
    });
  }
  const withoutHours = records.filter((record) => record.minutes === 0);
  if (withoutHours.length > 0) {
    const names = withoutHours
      .slice(0, 5)
      .map((record) => record.name)
      .join(", ");
    warnings.push({
      kind: "sin-horas",
      message:
        withoutHours.length +
        (withoutHours.length === 1 ? " miembro queda" : " miembros quedan") +
        " en cero horas: " +
        names +
        (withoutHours.length > 5 ? " y " + (withoutHours.length - 5) + " más." : "."),
    });
  }
  for (const record of records) {
    if (record.minutes > 100 * 60) {
      warnings.push({
        kind: "horas-altas",
        message:
          record.name +
          " tiene " +
          formatMinutes(record.minutes) +
          " en este período. Verificá que sea correcto.",
      });
    }
  }
  // Horas cargadas con una fecha que cae fuera del período.
  const [outOfRange] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(hourEntries)
    .where(
      and(
        eq(hourEntries.weekId, weekId),
        isNull(hourEntries.voidedAt),
        sql`(${hourEntries.workDate} < ${week.startDate} or ${hourEntries.workDate} > ${week.endDate})`,
      ),
    );
  if ((outOfRange?.value ?? 0) > 0) {
    warnings.push({
      kind: "fuera-de-rango",
      message:
        outOfRange?.value +
        " entrada(s) tienen una fecha fuera del rango " +
        formatPeriodLabel(week.startDate, week.endDate) +
        ".",
    });
  }
  /**
   * Caso de un período reabierto: si las horas cambiaron después de haberse
   * pagado, el importe abonado ya no coincide con el que corresponde. Hay que
   * verlo ANTES de volver a cerrar, no cuando alguien reclame.
   */
  const mismatched = await db
    .select({
      name: weeklyStaffRecords.staffNameSnapshot,
      expected: weeklyStaffRecords.calculatedAmount,
      paid: payments.amount,
    })
    .from(payments)
    .innerJoin(
      weeklyStaffRecords,
      and(
        eq(weeklyStaffRecords.weekId, payments.weekId),
        eq(weeklyStaffRecords.staffMemberId, payments.staffMemberId),
      ),
    )
    .where(
      and(
        eq(payments.weekId, weekId),
        isNull(payments.voidedAt),
        sql`${payments.amount} <> ${weeklyStaffRecords.calculatedAmount}`,
      ),
    );
  for (const row of mismatched) {
    warnings.push({
      kind: "pago-desfasado",
      message:
        "A " +
        row.name +
        " se le pagó " +
        formatMoney(row.paid) +
        " pero ahora le corresponden " +
        formatMoney(row.expected) +
        ". Revisá el pago antes de cerrar.",
    });
  }
  const totalMinutes = records.reduce((sum, record) => sum + record.minutes, 0);
  const totalAmount = records.reduce((sum, record) => sum + record.amount, 0);
  return {
    canClose: week.status === "open",
    warnings,
    totalMinutes,
    totalAmount,
    memberCount: records.length,
    membersWithHours: records.filter((record) => record.minutes > 0).length,
  };
}
/**
 * Cierra el período y congela la historia.
 *
 * Pasos, todos dentro de una única transacción:
 *   1. bloquear el período y validar estado y versión
 *   2. recalcular los snapshots con los datos vigentes
 *   3. congelarlos (`frozen_at`)
 *   4. grabar los totales del período
 *   5. cambiar el estado a cerrado
 *   6. registrar la auditoría
 *
 * Si algo falla en cualquier paso, no queda nada a medias: ni un período
 * cerrado con snapshots sin congelar, ni snapshots congelados en un período que
 * sigue abierto.
 */
export async function closeWeek(input: CloseWeekInput, actor: ActorContext): Promise<Week> {
  return withTransaction(async (tx) => {
    const week = await lockWeek(tx, input.id);
    if (week.status === "closed") {
      throw businessRule("El período ya está cerrado.");
    }
    if (week.version !== input.expectedVersion) {
      throw concurrency("El período cambió mientras lo revisabas. Recargá y volvé a intentar.");
    }
    await recalculateWeekRecords(tx, input.id);
    const now = new Date();
    await tx
      .update(weeklyStaffRecords)
      .set({ frozenAt: now })
      .where(and(eq(weeklyStaffRecords.weekId, input.id), isNull(weeklyStaffRecords.frozenAt)));
    const [totals] = await tx
      .select({
        totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
        totalAmount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
        memberCount: sql<number>`count(*)::int`,
      })
      .from(weeklyStaffRecords)
      .where(eq(weeklyStaffRecords.weekId, input.id));
    const [closed] = await tx
      .update(weeks)
      .set({
        status: "closed",
        closedAt: now,
        closedBy: actor.id,
        frozenTotalMinutes: totals?.totalMinutes ?? 0,
        frozenTotalAmount: Number(totals?.totalAmount ?? 0),
        frozenMemberCount: totals?.memberCount ?? 0,
        version: week.version + 1,
        updatedAt: now,
      })
      .where(and(eq(weeks.id, input.id), eq(weeks.version, input.expectedVersion)))
      .returning();
    if (!closed) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "WEEK_CLOSED",
      entity: "weeks",
      entityId: closed.id,
      summary:
        "Cerró el período " +
        formatPeriodLabel(closed.startDate, closed.endDate) +
        " — " +
        formatMinutes(closed.frozenTotalMinutes ?? 0) +
        " y " +
        formatMoney(closed.frozenTotalAmount ?? 0),
      before: { estado: week.status },
      after: {
        estado: closed.status,
        totalMinutos: closed.frozenTotalMinutes,
        totalImporte: closed.frozenTotalAmount,
        miembros: closed.frozenMemberCount,
      },
      metadata: { advertenciasAceptadas: input.acknowledgeWarnings },
    });
    return closed;
  });
}
/**
 * Reabre un período cerrado.
 *
 * Es la operación más delicada del sistema: descongela datos históricos. Por eso
 * requiere permiso propio (`weeks.reopen`), motivo obligatorio, confirmación
 * escrita, y queda contada en `reopen_count` para que sea visible que ese
 * período fue tocado después de cerrarse.
 */
export async function reopenWeek(input: ReopenWeekInput, actor: ActorContext): Promise<Week> {
  return withTransaction(async (tx) => {
    const week = await lockWeek(tx, input.id);
    if (week.status === "open") {
      throw businessRule("El período ya está abierto.");
    }
    if (week.version !== input.expectedVersion) {
      throw concurrency("El período cambió mientras lo revisabas. Recargá y volvé a intentar.");
    }
    const now = new Date();
    await tx
      .update(weeklyStaffRecords)
      .set({ frozenAt: null })
      .where(eq(weeklyStaffRecords.weekId, input.id));
    const [reopened] = await tx
      .update(weeks)
      .set({
        status: "open",
        reopenedAt: now,
        reopenedBy: actor.id,
        reopenReason: input.reason,
        reopenCount: week.reopenCount + 1,
        // Los totales congelados dejan de tener sentido: el período vuelve a moverse.
        frozenTotalMinutes: null,
        frozenTotalAmount: null,
        frozenMemberCount: null,
        closedAt: null,
        closedBy: null,
        version: week.version + 1,
        updatedAt: now,
      })
      .where(and(eq(weeks.id, input.id), eq(weeks.version, input.expectedVersion)))
      .returning();
    if (!reopened) throw concurrency();
    const [paymentCount] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(payments)
      .where(and(eq(payments.weekId, input.id), isNull(payments.voidedAt)));
    await appendAuditLog(tx, {
      actor,
      action: "WEEK_REOPENED",
      entity: "weeks",
      entityId: reopened.id,
      summary:
        "Reabrió el período " +
        formatPeriodLabel(reopened.startDate, reopened.endDate) +
        " (reapertura n.º " +
        reopened.reopenCount +
        ")",
      before: {
        estado: week.status,
        totalMinutos: week.frozenTotalMinutes,
        totalImporte: week.frozenTotalAmount,
        cerradoEl: week.closedAt,
      },
      after: { estado: reopened.status },
      reason: input.reason,
      metadata: { pagosYaRegistrados: paymentCount?.value ?? 0 },
    });
    return reopened;
  });
}
/* -------------------------------------------------------------------------- */
/* Utilidades internas                                                        */
/* -------------------------------------------------------------------------- */
async function lockWeek(tx: Transaction, id: string): Promise<Week> {
  const [week] = await tx.select().from(weeks).where(eq(weeks.id, id)).limit(1).for("update");
  if (!week) throw notFound("El período");
  return week;
}
/** Barrera compartida: nada modifica datos de un período cerrado. */
export function assertWeekOpen(week: Week): void {
  if (week.status !== "open") {
    throw businessRule(
      "El período " +
        formatPeriodLabel(week.startDate, week.endDate) +
        " está cerrado. Para modificarlo hay que reabrirlo con motivo, y eso requiere permiso de reapertura.",
    );
  }
}
export async function loadWeekForWrite(tx: Transaction, id: string): Promise<Week> {
  const week = await lockWeek(tx, id);
  assertWeekOpen(week);
  return week;
}
export async function countWeeks(
  executor: Executor = db,
): Promise<{ open: number; closed: number }> {
  const [row] = await executor
    .select({
      open: sql<number>`count(*) filter (where ${weeks.status} = 'open')::int`,
      closed: sql<number>`count(*) filter (where ${weeks.status} = 'closed')::int`,
    })
    .from(weeks);
  return { open: row?.open ?? 0, closed: row?.closed ?? 0 };
}
