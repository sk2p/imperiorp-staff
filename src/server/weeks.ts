import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
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
import { localDate } from "@/domain/clock";
import { formatMoney } from "@/domain/money";
import { GROUP_LIST, groupForCategory, type StaffGroup } from "@/domain/groups";
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
  DeleteWeekInput,
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
  /**
   * ¿Este período es el de ahora, o uno anterior?
   *
   * De eso depende si el nombre, el rango y la tarifa de cada ficha se vuelven
   * a copiar desde el staff de hoy. En el período en curso sí: un ascenso de
   * hoy rige para lo que se está liquidando hoy. En uno anterior, jamás.
   */
  const [semana] = await tx
    .select({ startDate: weeks.startDate, endDate: weeks.endDate })
    .from(weeks)
    .where(eq(weeks.id, weekId))
    .limit(1);

  if (!semana) throw notFound("El período");

  const hoy = localDate();
  const esElDeAhora = semana.startDate <= hoy && hoy <= semana.endDate;

  /**
   * Al tocar un período anterior, la identidad de cada fila no se toca.
   *
   * El rango y la tarifa quedaron grabados en la fila cuando ese período era el
   * actual: son el rango y la tarifa que esa persona TENÍA entonces. Volver a
   * copiarlos del staff de hoy reescribe la historia — alguien que era MOD++ en
   * septiembre y hoy es ADM+ aparecía como ADM+ en septiembre, y sus horas de
   * septiembre pasaban a valer la tarifa de ADM+. Basta con corregir una hora
   * del mes pasado para cambiarle a alguien lo que cobró.
   *
   * Sólo se recalculan los minutos y el importe, y el importe con la tarifa
   * GUARDADA en la fila, no con la de la tabla de tarifas.
   */
  const alActualizar = esElDeAhora
    ? sql`
      staff_name_snapshot   = excluded.staff_name_snapshot,
      rank_snapshot         = excluded.rank_snapshot,
      category_snapshot     = excluded.category_snapshot,
      hourly_rate_snapshot  = excluded.hourly_rate_snapshot,
      total_minutes         = excluded.total_minutes,
      calculated_amount     = excluded.calculated_amount,
      entry_count           = excluded.entry_count`
    : sql`
      total_minutes         = excluded.total_minutes,
      calculated_amount     = ((excluded.total_minutes::bigint
                                * weekly_staff_records.hourly_rate_snapshot::bigint
                                * 2 + 60) / 120)::bigint,
      entry_count           = excluded.entry_count`;

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
      ${alActualizar},
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
  readonly notes: string | null;
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
 *
 * El período de afuera se nombra a mano como `"weeks"."id"` y no interpolando
 * la columna. Cuando la consulta tiene una sola tabla, el ORM escribe las
 * columnas sin calificar —`"id"` pelado—, y adentro de estas subconsultas
 * `"id"` deja de significar lo que parece: `weekly_staff_records` y `payments`
 * tienen su propia columna `id`, y el nombre suelto se resuelve contra la tabla
 * de adentro. `where w.week_id = "id"` termina comparando el período contra el
 * identificador de la propia fila, no encuentra nunca nada, y todos los totales
 * dan cero sin que la base se queje: es SQL perfectamente válido.
 *
 * Escribirlo calificado corta el problema de raíz, y el alias `wsr` está para
 * que nadie lo vuelva a acortar a `w` y se repita la historia.
 */
const PERIODO = sql.raw('"weeks"."id"');

/**
 * `::bigint` vuelve de PostgreSQL como texto, no como número: el rango de un
 * bigint no entra en un `number` de JavaScript y el driver prefiere no perder
 * dígitos en silencio. Sin convertirlo, sumar importes concatena cadenas —
 * "0" + "818200000" — y el total sale disparatado. Los importes de acá son
 * pesos del servidor de rol, muy lejos del límite seguro de JavaScript.
 */

const weekTotalsSelect = {
  totalMinutes: sql<number>`coalesce("weeks"."frozen_total_minutes", (
    select coalesce(sum(wsr.total_minutes), 0)::int
      from weekly_staff_records wsr where wsr.week_id = ${PERIODO}
  ))`,
  totalAmount: sql<number>`coalesce("weeks"."frozen_total_amount", (
    select coalesce(sum(wsr.calculated_amount), 0)::bigint
      from weekly_staff_records wsr where wsr.week_id = ${PERIODO}
  ))::bigint`.mapWith(Number),
  memberCount: sql<number>`coalesce("weeks"."frozen_member_count", (
    select count(*)::int from weekly_staff_records wsr where wsr.week_id = ${PERIODO}
  ))`,
  paidCount: sql<number>`(
    select count(*)::int from payments pg where pg.week_id = ${PERIODO} and pg.voided_at is null
  )`,
  paidAmount: sql<number>`(
    select coalesce(sum(pg.amount), 0)::bigint
      from payments pg where pg.week_id = ${PERIODO} and pg.voided_at is null
  )::bigint`.mapWith(Number),
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
        notes: weeks.notes,
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

    let newStartDate = existing.startDate;
    let newEndDate = existing.endDate;
    let newCode = existing.code;

    if (input.startDate && input.endDate) {
      newStartDate = input.startDate;
      newEndDate = input.endDate;
      newCode = buildPeriodCode(newStartDate, newEndDate);

      if (newStartDate !== existing.startDate || newEndDate !== existing.endDate) {
        const [solapado] = await tx
          .select({ id: weeks.id, startDate: weeks.startDate, endDate: weeks.endDate })
          .from(weeks)
          .where(
            and(
              ne(weeks.id, input.id),
              sql`${weeks.startDate} <= ${newEndDate}`,
              sql`${weeks.endDate} >= ${newStartDate}`,
            ),
          )
          .limit(1);

        if (solapado) {
          throw conflict(
            "Las fechas elegidas (" +
              formatPeriodLabel(newStartDate, newEndDate) +
              ") se solapan con el período " +
              formatPeriodLabel(solapado.startDate, solapado.endDate) +
              ".",
          );
        }
      }
    }

    const [updated] = await tx
      .update(weeks)
      .set({
        code: newCode,
        startDate: newStartDate,
        endDate: newEndDate,
        label: input.label,
        notes: input.notes,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(weeks.id, input.id), eq(weeks.version, input.expectedVersion)))
      .returning();

    if (!updated) throw concurrency();

    if (newStartDate !== existing.startDate || newEndDate !== existing.endDate) {
      await recalculateWeekRecords(tx, updated.id);
    }

    await appendAuditLog(tx, {
      actor,
      action: "WEEK_UPDATED",
      entity: "weeks",
      entityId: updated.id,
      summary:
        "Editó el período " +
        (newStartDate !== existing.startDate || newEndDate !== existing.endDate
          ? formatPeriodLabel(existing.startDate, existing.endDate) +
            " → " +
            formatPeriodLabel(newStartDate, newEndDate)
          : formatPeriodLabel(updated.startDate, updated.endDate)),
      before: {
        inicio: existing.startDate,
        fin: existing.endDate,
        etiqueta: existing.label,
        notas: existing.notes,
      },
      after: {
        inicio: updated.startDate,
        fin: updated.endDate,
        etiqueta: updated.label,
        notas: updated.notes,
      },
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
/** Pagos cuyo importe ya no coincide con lo que corresponde. */
function consultaPagosDesfasados(weekId: string) {
  return db
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
}

export async function preflightClose(weekId: string): Promise<ClosePreflight> {
  const week = await requireWeek(weekId);
  const warnings: CloseWarning[] = [];

  /**
   * Las tres consultas que siguen sólo necesitan las fechas del período, que
   * ya están. Iban una detrás de otra sin motivo: contra una base remota eso
   * son tres esperas en fila para juntar datos que no dependen entre sí.
   */
  const [records, [outOfRange], mismatched] = await Promise.all([
    db
      .select({
        name: weeklyStaffRecords.staffNameSnapshot,
        minutes: weeklyStaffRecords.totalMinutes,
        amount: weeklyStaffRecords.calculatedAmount,
      })
      .from(weeklyStaffRecords)
      .where(eq(weeklyStaffRecords.weekId, weekId)),

    // Horas cargadas con una fecha que cae fuera del período.
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(hourEntries)
      .where(
        and(
          eq(hourEntries.weekId, weekId),
          isNull(hourEntries.voidedAt),
          sql`(${hourEntries.workDate} < ${week.startDate} or ${hourEntries.workDate} > ${week.endDate})`,
        ),
      ),

    /**
     * Caso de un período reabierto: si las horas cambiaron después de haberse
     * pagado, el importe abonado ya no coincide con el que corresponde. Hay que
     * verlo ANTES de volver a cerrar, no cuando alguien reclame.
     */
    consultaPagosDesfasados(weekId),
  ]);

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
        totalAmount:
          sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
            Number,
          ),
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
/* Borrado                                                                    */
/* -------------------------------------------------------------------------- */
/**
 * Qué hay adentro de un período, mirado desde la pregunta "¿se puede borrar?".
 *
 * Borrar un período no se deshace, así que la regla es una sola y no se
 * negocia: se borra lo que no contiene nada. El caso real es el período creado
 * por error —fechas mal tipeadas, uno de más— y ése está siempre vacío.
 *
 * Un período con horas adentro no se borra desde acá aunque quien lo pida
 * tenga todos los permisos del mundo. Esas horas son lo que cada uno va a
 * cobrar; hacerlas desaparecer con un botón y un diálogo no es una función, es
 * una trampa esperando al día que alguien se equivoque de fila. Para vaciarlo
 * está la planilla, donde borrar horas se hace de a una y queda registrado.
 *
 * Los pagos son todavía más terminantes: aunque estén anulados, un pago es
 * plata que se movió. Con un solo pago cargado, el período se queda.
 */
/**
 * Qué entrada de horas cuenta como horas de verdad.
 *
 * Poner una casilla en cero desde la planilla no borra la entrada: la anula, y
 * la entrada se queda con sus minutos originales más una marca de anulación.
 * Los totales del período la ignoran —por eso la pantalla muestra 0h— así que
 * contarla acá hacía que el sistema dijera "tiene 24 horas cargadas" sobre un
 * período que en pantalla estaba vacío. Quien lo leía no tenía forma de
 * entender de qué le estaban hablando.
 *
 * Es el mismo filtro que usa el recálculo: ni anulada, ni en un estado que no
 * sume.
 *
 * Las columnas van escritas a mano y calificadas en vez de interpoladas. Vale
 * igual en los dos lugares donde se usa —una consulta del ORM sobre esta misma
 * tabla y una subconsulta lateral escrita a mano— y deja fuera de toda duda
 * contra qué tabla se resuelve cada nombre.
 */
const VIGENTE = sql`hour_entries.voided_at is null and hour_entries.status = 'normal'`;

export interface DeletePreflight {
  readonly canDelete: boolean;
  /** Entradas de horas con tiempo cargado. */
  readonly entriesWithTime: number;
  readonly totalMinutes: number;
  readonly membersWithHours: number;
  /** Entradas marcadas (inactivo, justificado, anulado) aunque estén en cero. */
  readonly markedEntries: number;
  readonly paymentCount: number;
  /** Cuántos de esos pagos están anulados. */
  readonly paymentsVoided: number;
  /** Filas de planilla sembradas en cero: no dicen nada, se van con el período. */
  readonly emptyRecords: number;
  /** El motivo por el que no se puede, listo para mostrar. */
  readonly blocker: string | null;
}

export async function deleteWeekPreflight(
  weekId: string,
  executor: Executor = db,
): Promise<DeletePreflight> {
  const [entradas] = await executor
    .select({
      conTiempo: sql<number>`count(*) filter (where (${hourEntries.minutes} > 0 or ${hourEntries.seconds} > 0) and ${VIGENTE})::int`,
      marcadas: sql<number>`count(*) filter (where not (${VIGENTE}) or ${hourEntries.reason} is not null)::int`,
      minutos: sql<number>`coalesce(sum(${hourEntries.minutes}) filter (where ${VIGENTE}), 0)::int`,
      personas: sql<number>`count(distinct ${hourEntries.staffMemberId}) filter (where ${hourEntries.minutes} > 0 and ${VIGENTE})::int`,
    })
    .from(hourEntries)
    .where(eq(hourEntries.weekId, weekId));

  const [pagos] = await executor
    .select({
      total: sql<number>`count(*)::int`,
      anulados: sql<number>`count(*) filter (where ${payments.voidedAt} is not null)::int`,
    })
    .from(payments)
    .where(eq(payments.weekId, weekId));

  const [fichas] = await executor
    .select({ total: sql<number>`count(*)::int` })
    .from(weeklyStaffRecords)
    .where(eq(weeklyStaffRecords.weekId, weekId));

  return resolverPreflight({
    conTiempo: entradas?.conTiempo ?? 0,
    marcadas: entradas?.marcadas ?? 0,
    minutos: entradas?.minutos ?? 0,
    personas: entradas?.personas ?? 0,
    paymentCount: pagos?.total ?? 0,
    paymentsVoided: pagos?.anulados ?? 0,
    emptyRecords: fichas?.total ?? 0,
  });
}

/**
 * El veredicto y su explicación, a partir de los recuentos crudos.
 *
 * Se exporta para poder probarlo sin base de datos. Es la regla que decide si
 * algo se borra para siempre: conviene que tenga un test que falle en voz alta
 * el día que alguien la afloje.
 */
export function resolverPreflight(conteos: {
  conTiempo: number;
  marcadas: number;
  minutos: number;
  personas: number;
  paymentCount: number;
  paymentsVoided: number;
  emptyRecords: number;
}): DeletePreflight {
  /**
   * Un pago anulado también frena el borrado, y conviene decirlo con todas las
   * letras: la lista muestra "$0 pagado" porque lo anulado no suma, y sin esta
   * aclaración el mensaje parecería inventado. Anular un pago no lo borra —
   * queda el registro de que alguien cobró y después se revirtió—, y ese
   * registro vive colgado del período.
   */
  const todosAnulados = conteos.paymentCount > 0 && conteos.paymentsVoided === conteos.paymentCount;

  const blocker =
    conteos.paymentCount > 0
      ? "Tiene " +
        conteos.paymentCount +
        (conteos.paymentCount === 1 ? " pago registrado" : " pagos registrados") +
        (todosAnulados
          ? conteos.paymentCount === 1
            ? ", anulado"
            : ", todos anulados"
          : conteos.paymentsVoided > 0
            ? " (" + conteos.paymentsVoided + " anulados)"
            : "") +
        ". Un pago es plata que se movió, y anularlo no lo borra: el período que lo contiene se queda."
      : conteos.conTiempo > 0
        ? "Tiene " +
          formatMinutes(conteos.minutos) +
          " cargadas por " +
          conteos.personas +
          (conteos.personas === 1 ? " persona" : " personas") +
          ". Para borrarlo hay que vaciarlo antes desde la planilla."
        : null;

  return {
    canDelete: blocker === null,
    entriesWithTime: conteos.conTiempo,
    totalMinutes: conteos.minutos,
    membersWithHours: conteos.personas,
    markedEntries: conteos.marcadas,
    paymentCount: conteos.paymentCount,
    paymentsVoided: conteos.paymentsVoided,
    emptyRecords: conteos.emptyRecords,
    blocker,
  };
}

/**
 * Lo mismo, pero para todos los períodos de la pantalla de una sola vez.
 *
 * La versión de arriba hace tres consultas. Multiplicadas por veinte filas son
 * sesenta viajes a la base para pintar una lista. Acá son tres, agrupando por
 * período, y cada fila busca su resultado en el mapa.
 */
export async function deleteWeekPreflights(
  weekIds: readonly string[],
): Promise<ReadonlyMap<string, DeletePreflight>> {
  const mapa = new Map<string, DeletePreflight>();
  if (weekIds.length === 0) return mapa;

  const ids = sql.join(
    weekIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  /**
   * Un solo viaje a la base.
   *
   * Eran tres consultas en paralelo, que parece lo mismo y no lo es: la base
   * está en otro continente y cada conexión nueva cuesta un cuarto de segundo
   * de saludo TLS. Tres consultas "en paralelo" sobre un pool frío son tres
   * saludos, no uno.
   *
   * Acá los períodos entran como una lista y cada uno se cruza contra sus
   * propias subconsultas. La base hace el mismo trabajo; lo que se ahorra son
   * dos idas y vueltas.
   */
  const resultado = await db.execute<{
    week_id: string;
    con_tiempo: number;
    marcadas: number;
    minutos: number;
    personas: number;
    pagos: number;
    pagos_anulados: number;
    fichas: number;
  }>(sql`
    select
      p.id as week_id,
      coalesce(e.con_tiempo, 0) as con_tiempo,
      coalesce(e.marcadas, 0)   as marcadas,
      coalesce(e.minutos, 0)    as minutos,
      coalesce(e.personas, 0)   as personas,
      coalesce(g.pagos, 0)      as pagos,
      coalesce(g.anulados, 0)   as pagos_anulados,
      coalesce(f.fichas, 0)     as fichas
    from unnest(array[${ids}]) as p(id)
    left join lateral (
      select
        count(*) filter (where (hour_entries.minutes > 0 or hour_entries.seconds > 0) and ${VIGENTE})::int as con_tiempo,
        count(*) filter (where not (${VIGENTE}) or hour_entries.reason is not null)::int as marcadas,
        coalesce(sum(hour_entries.minutes) filter (where ${VIGENTE}), 0)::int as minutos,
        count(distinct hour_entries.staff_member_id) filter (where hour_entries.minutes > 0 and ${VIGENTE})::int as personas
      from hour_entries
      where hour_entries.week_id = p.id
    ) e on true
    left join lateral (
      select count(*)::int as pagos,
             count(*) filter (where voided_at is not null)::int as anulados
      from payments where payments.week_id = p.id
    ) g on true
    left join lateral (
      select count(*)::int as fichas
      from weekly_staff_records where weekly_staff_records.week_id = p.id
    ) f on true
  `);

  for (const fila of resultado.rows ?? []) {
    mapa.set(
      fila.week_id,
      resolverPreflight({
        conTiempo: Number(fila.con_tiempo),
        marcadas: Number(fila.marcadas),
        minutos: Number(fila.minutos),
        personas: Number(fila.personas),
        paymentCount: Number(fila.pagos),
        paymentsVoided: Number(fila.pagos_anulados),
        emptyRecords: Number(fila.fichas),
      }),
    );
  }

  return mapa;
}

/**
 * Borra un período vacío.
 *
 * Se vuelve a comprobar todo adentro de la transacción y con el período
 * bloqueado. Lo que el navegador mandó es una foto de hace unos segundos, y en
 * el medio alguien pudo haber cargado el domingo desde el teléfono.
 *
 * La auditoría se escribe ANTES del borrado y se queda con una copia de lo que
 * había: el registro tiene que sobrevivir a la fila que describe. Por eso el
 * `entityId` apunta a un período que después deja de existir, y el `before`
 * guarda sus fechas y su etiqueta — sin eso, el renglón diría "borró algo" y
 * nada más.
 */
export async function deleteWeek(
  input: DeleteWeekInput,
  actor: ActorContext,
): Promise<{ startDate: string; endDate: string }> {
  return withTransaction(async (tx) => {
    const week = await lockWeek(tx, input.id);

    if (week.version !== input.expectedVersion) {
      throw concurrency("El período cambió mientras lo revisabas. Recargá y volvé a intentar.");
    }

    const revision = await deleteWeekPreflight(input.id, tx);
    if (!revision.canDelete) {
      throw businessRule(
        "No se puede borrar " +
          formatPeriodLabel(week.startDate, week.endDate) +
          ". " +
          (revision.blocker ?? ""),
      );
    }

    await appendAuditLog(tx, {
      actor,
      action: "WEEK_DELETED",
      entity: "weeks",
      entityId: week.id,
      summary:
        "Borró el período " +
        formatPeriodLabel(week.startDate, week.endDate) +
        (week.label ? " (" + week.label + ")" : ""),
      before: {
        codigo: week.code,
        etiqueta: week.label,
        desde: week.startDate,
        hasta: week.endDate,
        estado: week.status,
        notas: week.notes,
        creadoEl: week.createdAt,
      },
      after: null,
      reason: input.reason,
      metadata: {
        fichasEnCero: revision.emptyRecords,
        entradasVacias: revision.markedEntries,
      },
    });

    /**
     * Las entradas en cero se van a mano porque su clave foránea es
     * `restrict`: esa restricción existe para que nadie borre horas de rebote,
     * y acá ya está probado que no hay ninguna hora que borrar. Las filas de
     * planilla, en cambio, caen solas con el período.
     */
    await tx.delete(hourEntries).where(eq(hourEntries.weekId, input.id));
    await tx.delete(weeks).where(eq(weeks.id, input.id));

    return { startDate: week.startDate, endDate: week.endDate };
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

/* -------------------------------------------------------------------------- */
/* Qué hay adentro de un período                                              */
/* -------------------------------------------------------------------------- */
/**
 * La lista de períodos mostraba un total de horas y nada más. Un total no dice
 * nada útil por sí solo: 500 horas pueden ser cuarenta personas trabajando
 * parejo o tres personas cargando de más. Y con dos períodos abiertos a la vez
 * —cosa que pasa el día que se abre el nuevo antes de cerrar el viejo— el
 * total del que no es "el activo" queda escondido en una fila.
 *
 * Esto abre cada período: cuánto puso cada categoría, cuánta gente de las que
 * figuran cargó horas de verdad, y quiénes son los tres que más sumaron.
 *
 * Se pide una sola vez para TODOS los períodos de la página, no uno por fila:
 * dos consultas fijas en lugar de veinte.
 */
export interface WeekGroupSlice {
  readonly group: StaffGroup;
  readonly label: string;
  readonly minutes: number;
  readonly amount: number;
  readonly members: number;
}

export interface WeekBreakdown {
  readonly membersWithHours: number;
  readonly totalMinutes: number;
  readonly groups: readonly WeekGroupSlice[];
  readonly top: readonly {
    readonly name: string;
    readonly rank: string;
    readonly minutes: number;
  }[];
}

export async function weekBreakdowns(
  weekIds: readonly string[],
): Promise<ReadonlyMap<string, WeekBreakdown>> {
  const mapa = new Map<string, WeekBreakdown>();
  if (weekIds.length === 0) return mapa;

  const ids = sql.join(
    weekIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const [porCategoria, mejores] = await Promise.all([
    db.execute<{
      week_id: string;
      category_snapshot: string;
      minutes: number;
      amount: string | number;
      members: number;
    }>(sql`
      select week_id, category_snapshot,
             sum(total_minutes)::int        as minutes,
             sum(calculated_amount)::bigint as amount,
             count(*)::int                  as members
        from weekly_staff_records
       where week_id in (${ids}) and total_minutes > 0
       group by week_id, category_snapshot
    `),
    db.execute<{
      week_id: string;
      staff_name_snapshot: string;
      rank_snapshot: string;
      total_minutes: number;
    }>(sql`
      select week_id, staff_name_snapshot, rank_snapshot, total_minutes
        from (
          select week_id, staff_name_snapshot, rank_snapshot, total_minutes,
                 row_number() over (partition by week_id order by total_minutes desc) as puesto
            from weekly_staff_records
           where week_id in (${ids}) and total_minutes > 0
        ) ranked
       where puesto <= 3
       order by week_id, total_minutes desc
    `),
  ]);

  /** Acumulador por período; las categorías se pliegan a los tres grupos. */
  const crudo = new Map<
    string,
    {
      grupos: Map<StaffGroup, { minutes: number; amount: number; members: number }>;
      miembros: number;
    }
  >();

  for (const fila of porCategoria.rows ?? []) {
    const entrada = crudo.get(fila.week_id) ?? { grupos: new Map(), miembros: 0 };
    const grupo = groupForCategory(fila.category_snapshot);
    const previo = entrada.grupos.get(grupo) ?? { minutes: 0, amount: 0, members: 0 };

    entrada.grupos.set(grupo, {
      minutes: previo.minutes + Number(fila.minutes),
      amount: previo.amount + Number(fila.amount),
      members: previo.members + Number(fila.members),
    });
    entrada.miembros += Number(fila.members);
    crudo.set(fila.week_id, entrada);
  }

  const topes = new Map<string, { name: string; rank: string; minutes: number }[]>();
  for (const fila of mejores.rows ?? []) {
    const lista = topes.get(fila.week_id) ?? [];
    lista.push({
      name: fila.staff_name_snapshot,
      rank: fila.rank_snapshot,
      minutes: Number(fila.total_minutes),
    });
    topes.set(fila.week_id, lista);
  }

  for (const [weekId, entrada] of crudo) {
    // Se listan en orden de jerarquía, no en el que los devolvió la base.
    const groups = GROUP_LIST.flatMap((definicion) => {
      const dato = entrada.grupos.get(definicion.group);
      if (!dato || dato.minutes <= 0) return [];
      return [{ group: definicion.group, label: definicion.label, ...dato }];
    });

    mapa.set(weekId, {
      membersWithHours: entrada.miembros,
      totalMinutes: groups.reduce((suma, grupo) => suma + grupo.minutes, 0),
      groups,
      top: topes.get(weekId) ?? [],
    });
  }

  return mapa;
}
