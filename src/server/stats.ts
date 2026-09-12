import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { payments, staffMembers, weeklyStaffRecords, weeks } from "@/db/schema";
import { CATEGORY_LABELS, RANK_DEFINITIONS, type StaffCategory } from "@/domain/ranks";
/**
 * IMPERIO RP — Estadísticas.
 *
 * Todas las cifras salen de `weekly_staff_records`, que es el registro
 * congelado. Eso hace que un gráfico de hace seis meses muestre siempre lo
 * mismo, aunque desde entonces hayan cambiado rangos, tarifas o nombres.
 *
 * Las agregaciones se resuelven en PostgreSQL: traer miles de filas a Node para
 * sumarlas ahí funcionaría el primer año y se volvería inusable al tercero.
 */
export interface GlobalStats {
  readonly totalMinutes: number;
  readonly totalGenerated: number;
  readonly totalPaid: number;
  readonly totalPending: number;
  readonly weeksClosed: number;
  readonly weeksOpen: number;
  readonly activeStaff: number;
  readonly archivedStaff: number;
  readonly averageMinutesPerMember: number;
  readonly paymentsCount: number;
}
/**
 * Las cifras generales del sistema, en UNA sola consulta.
 *
 * Eran cinco, una detrás de otra. En un servidor al lado de la base eso no se
 * nota; contra una base remota cada viaje cuesta unos cincuenta milisegundos y
 * cinco viajes en fila son un cuarto de segundo de pantalla en blanco, cada vez
 * que alguien abre el tablero — y el tablero se refresca solo cada doce
 * segundos.
 *
 * Van todas como subconsultas de un `select` sin `from`: PostgreSQL las resuelve
 * en paralelo y devuelve una fila. El trabajo de la base es el mismo; lo que se
 * ahorra son cuatro idas y vueltas por la red.
 */
export async function getGlobalStats(): Promise<GlobalStats> {
  const resultado = await db.execute<{
    total_minutes: number;
    total_generated: string;
    members_with_hours: number;
    closed_generated: string;
    total_paid: string;
    payments_count: number;
    weeks_closed: number;
    weeks_open: number;
    staff_active: number;
    staff_archived: number;
  }>(sql`
    select
      (select coalesce(sum(total_minutes), 0)::int from weekly_staff_records) as total_minutes,
      (select coalesce(sum(calculated_amount), 0)::bigint from weekly_staff_records) as total_generated,
      (select count(*) filter (where total_minutes > 0)::int from weekly_staff_records) as members_with_hours,
      (select coalesce(sum(r.calculated_amount), 0)::bigint
         from weekly_staff_records r join weeks w on w.id = r.week_id
        where w.status = 'closed') as closed_generated,
      (select coalesce(sum(amount), 0)::bigint from payments where voided_at is null) as total_paid,
      (select count(*)::int from payments where voided_at is null) as payments_count,
      (select count(*) filter (where status = 'closed')::int from weeks) as weeks_closed,
      (select count(*) filter (where status = 'open')::int from weeks) as weeks_open,
      (select count(*) filter (where archived_at is null)::int from staff_members) as staff_active,
      (select count(*) filter (where archived_at is not null)::int from staff_members) as staff_archived
  `);

  const fila = resultado.rows?.[0];

  const totalMinutes = Number(fila?.total_minutes ?? 0);
  const totalGenerated = Number(fila?.total_generated ?? 0);
  const totalPaid = Number(fila?.total_paid ?? 0);
  const membersWithHours = Number(fila?.members_with_hours ?? 0);

  return {
    totalMinutes,
    totalGenerated,
    totalPaid,
    // Lo pendiente sólo cuenta lo ya liquidado: un período abierto todavía no se debe.
    totalPending: Math.max(0, Number(fila?.closed_generated ?? 0) - totalPaid),
    weeksClosed: Number(fila?.weeks_closed ?? 0),
    weeksOpen: Number(fila?.weeks_open ?? 0),
    activeStaff: Number(fila?.staff_active ?? 0),
    archivedStaff: Number(fila?.staff_archived ?? 0),
    averageMinutesPerMember:
      membersWithHours === 0 ? 0 : Math.round(totalMinutes / membersWithHours),
    paymentsCount: Number(fila?.payments_count ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Series temporales                                                          */
/* -------------------------------------------------------------------------- */
export interface WeekSeriesPoint {
  readonly weekId: string;
  readonly code: string;
  readonly label: string | null;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly paidAmount: number;
  readonly memberCount: number;
}
/** Evolución por período. Es la serie principal de la pantalla de análisis. */
export async function getWeekSeries(limit = 16): Promise<WeekSeriesPoint[]> {
  const rows = await db
    .select({
      weekId: weeks.id,
      code: weeks.code,
      label: weeks.label,
      startDate: weeks.startDate,
      endDate: weeks.endDate,
      status: weeks.status,
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalAmount:
        sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
          Number,
        ),
      memberCount: sql<number>`count(${weeklyStaffRecords.id})::int`,
      /**
       * El período se nombra calificado a propósito. `payments` tiene su propia
       * columna `id`, así que un `"id"` sin tabla adelante se resolvería contra
       * la tabla de adentro y la subconsulta no encontraría nunca nada —
       * devolvería cero sin error. Acá el ORM lo califica porque la consulta
       * tiene join, pero eso es una casualidad de esta consulta, no una
       * garantía.
       */
      paidAmount: sql<number>`coalesce((
        select sum(pg.amount) from payments pg
        where pg.week_id = "weeks"."id" and pg.voided_at is null
      ), 0)::bigint`.mapWith(Number),
    })
    .from(weeks)
    .leftJoin(weeklyStaffRecords, eq(weeklyStaffRecords.weekId, weeks.id))
    .groupBy(weeks.id)
    .orderBy(desc(weeks.startDate))
    .limit(limit);
  // Se consulta de la más nueva a la más vieja y se invierte: los gráficos leen
  // de izquierda a derecha en orden cronológico.
  return rows.reverse().map((row) => ({
    ...row,
    totalAmount: Number(row.totalAmount),
    paidAmount: Number(row.paidAmount),
  }));
}
export interface MonthSeriesPoint {
  readonly month: string;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly weekCount: number;
}
export async function getMonthSeries(months = 12): Promise<MonthSeriesPoint[]> {
  const rows = await db
    .select({
      month: sql<string>`to_char(${weeks.startDate}, 'YYYY-MM')`,
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalAmount:
        sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
          Number,
        ),
      weekCount: sql<number>`count(distinct ${weeks.id})::int`,
    })
    .from(weeks)
    .leftJoin(weeklyStaffRecords, eq(weeklyStaffRecords.weekId, weeks.id))
    .groupBy(sql`to_char(${weeks.startDate}, 'YYYY-MM')`)
    .orderBy(desc(sql`to_char(${weeks.startDate}, 'YYYY-MM')`))
    .limit(months);
  return rows.reverse().map((row) => ({ ...row, totalAmount: Number(row.totalAmount) }));
}
/* -------------------------------------------------------------------------- */
/* Distribuciones                                                             */
/* -------------------------------------------------------------------------- */
export interface RankDistribution {
  readonly rank: string;
  readonly category: string;
  readonly memberCount: number;
  readonly totalMinutes: number;
  readonly totalAmount: number;
}
export async function getRankDistribution(weekId?: string): Promise<RankDistribution[]> {
  const rows = await db
    .select({
      rank: weeklyStaffRecords.rankSnapshot,
      category: weeklyStaffRecords.categorySnapshot,
      memberCount: sql<number>`count(distinct ${weeklyStaffRecords.staffMemberId})::int`,
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalAmount:
        sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
          Number,
        ),
    })
    .from(weeklyStaffRecords)
    .where(weekId ? eq(weeklyStaffRecords.weekId, weekId) : undefined)
    .groupBy(weeklyStaffRecords.rankSnapshot, weeklyStaffRecords.categorySnapshot);
  return rows
    .map((row) => ({ ...row, totalAmount: Number(row.totalAmount) }))
    .sort(
      (a, b) =>
        (RANK_DEFINITIONS[a.rank as keyof typeof RANK_DEFINITIONS]?.tier ?? 0) -
        (RANK_DEFINITIONS[b.rank as keyof typeof RANK_DEFINITIONS]?.tier ?? 0),
    );
}
export interface CategoryDistribution {
  readonly category: StaffCategory | string;
  readonly label: string;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly memberCount: number;
}
export async function getCategoryDistribution(weekId?: string): Promise<CategoryDistribution[]> {
  const rows = await db
    .select({
      category: weeklyStaffRecords.categorySnapshot,
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalAmount:
        sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
          Number,
        ),
      memberCount: sql<number>`count(distinct ${weeklyStaffRecords.staffMemberId})::int`,
    })
    .from(weeklyStaffRecords)
    .where(weekId ? eq(weeklyStaffRecords.weekId, weekId) : undefined)
    .groupBy(weeklyStaffRecords.categorySnapshot);
  return rows.map((row) => ({
    ...row,
    totalAmount: Number(row.totalAmount),
    label: CATEGORY_LABELS[row.category as StaffCategory] ?? row.category,
  }));
}
/* -------------------------------------------------------------------------- */
/* Rankings                                                                   */
/* -------------------------------------------------------------------------- */
export interface TopMember {
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly weekCount: number;
}
export async function getTopMembers(limit = 10, weekId?: string): Promise<TopMember[]> {
  return db
    .select({
      staffMemberId: weeklyStaffRecords.staffMemberId,
      name: sql<string>`max(${weeklyStaffRecords.staffNameSnapshot})`,
      rank: sql<string>`max(${weeklyStaffRecords.rankSnapshot})`,
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalAmount:
        sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
          Number,
        ),
      weekCount: sql<number>`count(distinct ${weeklyStaffRecords.weekId})::int`,
    })
    .from(weeklyStaffRecords)
    .where(weekId ? eq(weeklyStaffRecords.weekId, weekId) : undefined)
    .groupBy(weeklyStaffRecords.staffMemberId)
    .having(sql`sum(${weeklyStaffRecords.totalMinutes}) > 0`)
    .orderBy(desc(sql`sum(${weeklyStaffRecords.totalMinutes})`))
    .limit(limit);
}
/** Miembros sin actividad en el período. Sirve para detectar inactividad. */
export async function getInactiveMembers(weekId: string, limit = 20) {
  return db
    .select({
      staffMemberId: weeklyStaffRecords.staffMemberId,
      name: weeklyStaffRecords.staffNameSnapshot,
      rank: weeklyStaffRecords.rankSnapshot,
    })
    .from(weeklyStaffRecords)
    .where(and(eq(weeklyStaffRecords.weekId, weekId), eq(weeklyStaffRecords.totalMinutes, 0)))
    .orderBy(asc(weeklyStaffRecords.staffNameSnapshot))
    .limit(limit);
}
/* -------------------------------------------------------------------------- */
/* Comparativa entre períodos                                                 */
/* -------------------------------------------------------------------------- */
export interface PeriodComparison {
  readonly currentMinutes: number;
  readonly previousMinutes: number;
  readonly minutesDelta: number;
  readonly currentAmount: number;
  readonly previousAmount: number;
  readonly amountDelta: number;
  readonly hasPrevious: boolean;
}
/** Compara un período con el inmediatamente anterior. */
export async function comparePeriods(weekId: string): Promise<PeriodComparison> {
  const [current] = await db
    .select({ startDate: weeks.startDate })
    .from(weeks)
    .where(eq(weeks.id, weekId))
    .limit(1);
  const empty: PeriodComparison = {
    currentMinutes: 0,
    previousMinutes: 0,
    minutesDelta: 0,
    currentAmount: 0,
    previousAmount: 0,
    amountDelta: 0,
    hasPrevious: false,
  };
  if (!current) return empty;
  const [previous] = await db
    .select({ id: weeks.id })
    .from(weeks)
    .where(sql`${weeks.startDate} < ${current.startDate}`)
    .orderBy(desc(weeks.startDate))
    .limit(1);
  const totalsFor = async (id: string) => {
    const [row] = await db
      .select({
        minutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
        amount:
          sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
            Number,
          ),
      })
      .from(weeklyStaffRecords)
      .where(eq(weeklyStaffRecords.weekId, id));
    return { minutes: row?.minutes ?? 0, amount: Number(row?.amount ?? 0) };
  };
  const currentTotals = await totalsFor(weekId);
  if (!previous) {
    return {
      ...empty,
      currentMinutes: currentTotals.minutes,
      currentAmount: currentTotals.amount,
    };
  }
  const previousTotals = await totalsFor(previous.id);
  return {
    currentMinutes: currentTotals.minutes,
    previousMinutes: previousTotals.minutes,
    minutesDelta: currentTotals.minutes - previousTotals.minutes,
    currentAmount: currentTotals.amount,
    previousAmount: previousTotals.amount,
    amountDelta: currentTotals.amount - previousTotals.amount,
    hasPrevious: true,
  };
}
/* -------------------------------------------------------------------------- */
/* Actividad de los usuarios del sistema                                      */
/* -------------------------------------------------------------------------- */
export interface RecorderActivity {
  readonly username: string;
  readonly entryCount: number;
  readonly totalMinutes: number;
}
/** Quién carga las horas. Útil para repartir la tarea entre el equipo. */
export async function getRecorderActivity(days = 30): Promise<RecorderActivity[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return db
    .select({
      username: sql<string>`he.recorded_by_username`,
      entryCount: sql<number>`count(*)::int`,
      totalMinutes: sql<number>`coalesce(sum(he.minutes), 0)::int`,
    })
    .from(sql`hour_entries he`)
    .where(and(gte(sql`he.created_at`, since), sql`he.voided_at is null`))
    .groupBy(sql`he.recorded_by_username`)
    .orderBy(desc(sql`count(*)`))
    .limit(12);
}
