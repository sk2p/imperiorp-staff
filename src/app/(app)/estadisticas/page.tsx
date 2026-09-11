import type { Metadata } from "next";

import { Icon } from "@/components/layout/icons";
import { BarChart, DistributionBars, LineChart } from "@/components/ui/charts";
import { WeekSelector } from "@/components/ui/filters";
import { Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/primitives";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { formatCalendarDateShort, formatMonthKey } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import {
  comparePeriods,
  getCategoryDistribution,
  getGlobalStats,
  getMonthSeries,
  getRankDistribution,
  getRecorderActivity,
  getTopMembers,
  getWeekSeries,
} from "@/server/stats";
import { getCurrentWeek, listWeekOptions } from "@/server/weeks";

export const metadata: Metadata = { title: "Estadísticas" };
export const dynamic = "force-dynamic";

export default async function StatsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ periodo?: string }>;
}) {
  await requirePermission(PERMISSIONS.STATS_VIEW);
  const params = await searchParams;

  const weekOptions = await listWeekOptions();
  const currentWeek = await getCurrentWeek();
  const weekId =
    (params.periodo && weekOptions.some((week) => week.id === params.periodo)
      ? params.periodo
      : null) ??
    currentWeek?.id ??
    weekOptions[0]?.id ??
    null;

  const [
    stats,
    weekSeries,
    monthSeries,
    ranks,
    categories,
    topAll,
    topWeek,
    recorders,
    comparison,
  ] = await Promise.all([
    getGlobalStats(),
    getWeekSeries(14),
    getMonthSeries(12),
    getRankDistribution(),
    getCategoryDistribution(),
    getTopMembers(10),
    weekId ? getTopMembers(10, weekId) : Promise.resolve([]),
    getRecorderActivity(30),
    weekId ? comparePeriods(weekId) : Promise.resolve(null),
  ]);

  const hasData = weekSeries.length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Análisis"
        title="Estadísticas"
        description="Todas las cifras salen de las liquidaciones congeladas, así que no cambian con el tiempo."
        actions={<WeekSelector weeks={weekOptions} currentId={weekId} />}
      />

      {!hasData ? (
        <Card>
          <EmptyState
            icon={<Icon name="chart" size={20} />}
            title="Todavía no hay datos suficientes"
            description="Cargá horas en un período para empezar a ver la evolución."
          />
        </Card>
      ) : (
        <>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Horas históricas"
              value={formatMinutes(stats.totalMinutes)}
              hint={"Promedio " + formatMinutes(stats.averageMinutesPerMember) + " por miembro"}
            />
            <Stat
              label="Dinero generado"
              value={formatMoneyCompact(stats.totalGenerated)}
              hint={formatMoney(stats.totalGenerated)}
              accent
            />
            <Stat
              label="Dinero pagado"
              value={formatMoneyCompact(stats.totalPaid)}
              hint={stats.paymentsCount + " pagos registrados"}
            />
            <Stat
              label="Pendiente de pago"
              value={formatMoneyCompact(stats.totalPending)}
              hint="Sólo de períodos ya cerrados"
            />
          </div>

          {comparison?.hasPrevious ? (
            <div className="stagger grid grid-cols-2 gap-3">
              <Stat
                label="Horas vs. período anterior"
                value={formatMinutes(comparison.currentMinutes)}
                trend={{
                  value: comparison.minutesDelta,
                  label:
                    (comparison.minutesDelta >= 0 ? "+" : "−") +
                    formatMinutes(Math.abs(comparison.minutesDelta)) +
                    " respecto del anterior",
                }}
              />
              <Stat
                label="Importe vs. período anterior"
                value={formatMoneyCompact(comparison.currentAmount)}
                trend={{
                  value: comparison.amountDelta,
                  label:
                    (comparison.amountDelta >= 0 ? "+" : "−") +
                    formatMoneyCompact(Math.abs(comparison.amountDelta)) +
                    " respecto del anterior",
                }}
              />
            </div>
          ) : null}

          <Card>
            <CardHeader
              title="Dinero generado y pagado por período"
              description="La barra gris es lo generado; la verde, lo efectivamente abonado."
            />
            <div className="p-4">
              <BarChart
                format="money"
                height={200}
                secondaryLabel="Pagado"
                data={weekSeries.map((point) => ({
                  label: formatCalendarDateShort(point.startDate),
                  value: point.totalAmount,
                  secondary: point.paidAmount,
                  highlight: point.status === "open",
                }))}
              />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Horas por período" />
              <div className="p-4">
                <LineChart
                  format="minutes"
                  data={weekSeries.map((point) => ({
                    label: formatCalendarDateShort(point.startDate),
                    value: point.totalMinutes,
                  }))}
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Evolución mensual" description="Horas acumuladas por mes." />
              <div className="p-4">
                <BarChart
                  format="minutes"
                  data={monthSeries.map((point) => ({
                    label: formatMonthKey(point.month).slice(0, 3),
                    value: point.totalMinutes,
                  }))}
                />
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Horas por rango" description="Histórico acumulado." />
              <div className="p-4">
                <DistributionBars
                  format="minutes"
                  data={ranks.map((rank) => ({
                    label: rank.rank,
                    sublabel: rank.memberCount + " miembro(s)",
                    value: rank.totalMinutes,
                  }))}
                />
              </div>
            </Card>

            <Card>
              <CardHeader title="Dinero por categoría" description="Histórico acumulado." />
              <div className="p-4">
                <DistributionBars
                  format="money"
                  data={categories.map((category) => ({
                    label: category.label,
                    sublabel: category.memberCount + " miembro(s)",
                    value: category.totalAmount,
                  }))}
                />
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Más horas en el período"
                description="Ranking del período seleccionado."
              />
              <div className="p-4">
                {topWeek.length === 0 ? (
                  <p className="text-chalk-600 py-8 text-center text-xs">
                    Sin horas cargadas en este período.
                  </p>
                ) : (
                  <DistributionBars
                    format="minutes"
                    data={topWeek.map((member) => ({
                      label: member.name,
                      sublabel: member.rank,
                      value: member.totalMinutes,
                    }))}
                  />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Más horas históricas"
                description="Acumulado de todos los períodos."
              />
              <div className="p-4">
                <DistributionBars
                  format="minutes"
                  data={topAll.map((member) => ({
                    label: member.name,
                    sublabel: member.weekCount + " períodos",
                    value: member.totalMinutes,
                    tone: "bg-sky-400",
                  }))}
                />
              </div>
            </Card>
          </div>

          {recorders.length > 0 ? (
            <Card>
              <CardHeader
                title="Quién carga las horas"
                description="Últimos 30 días. Sirve para repartir la tarea entre el equipo."
              />
              <div className="p-4">
                <DistributionBars
                  format="number"
                  data={recorders.map((recorder) => ({
                    label: recorder.username,
                    sublabel: formatMinutes(recorder.totalMinutes),
                    value: recorder.entryCount,
                    tone: "bg-amber-400",
                  }))}
                />
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
