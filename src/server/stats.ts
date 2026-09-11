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
export async function getGlobalStats(): Promise<GlobalStats> {
  const [records] = await db
    .select({
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalGenerated: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
      membersWithHours: sql<number>`count(*) filter (where ${weeklyStaffRecords.totalMinutes} > 0)::int`,
    })
    .from(weeklyStaffRecords);
  const [paid] = await db
    .select({
      total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(payments)
    .where(isNull(payments.voidedAt));
  const [weekCounts] = await db
    .select({
      closed: sql<number>`count(*) filter (where ${weeks.status} = 'closed')::int`,
      open: sql<number>`count(*) filter (where ${weeks.status} = 'open')::int`,
    })
    .from(weeks);
  const [staffCounts] = await db
    .select({
      active: sql<number>`count(*) filter (where ${staffMembers.archivedAt} is null)::int`,
      archived: sql<number>`count(*) filter (where ${staffMembers.archivedAt} is not null)::int`,
    })
    .from(staffMembers);
  const totalMinutes = records?.totalMinutes ?? 0;
  const totalGenerated = Number(records?.totalGenerated ?? 0);
  const totalPaid = Number(paid?.total ?? 0);
  const membersWithHours = records?.membersWithHours ?? 0;
  return {
    totalMinutes,
    totalGenerated,
    totalPaid,
    // Lo pendiente sólo cuenta lo ya liquidado: un período abierto todavía no se debe.
    totalPending: Math.max(0, (await getClosedGeneratedTotal()) - totalPaid),
    weeksClosed: weekCounts?.closed ?? 0,
    weeksOpen: weekCounts?.open ?? 0,
    activeStaff: staffCounts?.active ?? 0,
    archivedStaff: staffCounts?.archived ?? 0,
    averageMinutesPerMember:
      membersWithHours === 0 ? 0 : Math.round(totalMinutes / membersWithHours),
    paymentsCount: paid?.count ?? 0,
  };
}
async function getClosedGeneratedTotal(): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
    })
    .from(weeklyStaffRecords)
    .innerJoin(weeks, eq(weeklyStaffRecords.weekId, weeks.id))
    .where(eq(weeks.status, "closed"));
  return Number(row?.total ?? 0);
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
      totalAmount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
      memberCount: sql<number>`count(${weeklyStaffRecords.id})::int`,
      paidAmount: sql<number>`coalesce((
        select sum(p.amount) from payments p
        where p.week_id = ${weeks.id} and p.voided_at is null
      ), 0)::bigint`,
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
      totalAmount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
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
      totalAmount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
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
      totalAmount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
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
      totalAmount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
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
        amount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
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
