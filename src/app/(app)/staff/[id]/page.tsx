import type { Metadata } from "next";
import { localDateShort, localDateTime } from "@/domain/clock";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Icon } from "@/components/layout/icons";
import { LineChart } from "@/components/ui/charts";
import { WeekSelector } from "@/components/ui/filters";
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
} from "@/components/ui/primitives";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { explainCalculation } from "@/domain/payroll";
import { formatCalendarDate, formatCalendarDateShort, formatPeriodLabel } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { CATEGORY_ACCENT, rankLabel, type StaffCategory } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { getStaffHistory, getStaffWeekBreakdown } from "@/server/hours";
import { getStaffPayments } from "@/server/payments";
import { getStaffRankHistory, requireStaffMember } from "@/server/staff";
import { getCurrentWeek, getWeekDetail, listWeekOptions } from "@/server/weeks";

export const metadata: Metadata = { title: "Ficha del miembro" };
export const dynamic = "force-dynamic";

/**
 * Ficha completa de un miembro.
 *
 * Esta pantalla existe para responder, sin ambigüedad, la pregunta que define
 * al sistema: cuántas horas hizo una persona en un período, cuánto le
 * correspondía, con qué rango y tarifa, de qué turnos salió ese total y si ya
 * se le pagó.
 */
export default async function StaffDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ periodo?: string }>;
}) {
  const { can } = await requirePermission(PERMISSIONS.STAFF_VIEW);
  const { id } = await params;
  const query = await searchParams;

  const member = await requireStaffMember(id).catch(() => null);
  if (!member) notFound();

  const weekOptions = await listWeekOptions();
  const currentWeek = await getCurrentWeek();
  const weekId =
    (query.periodo && weekOptions.some((week) => week.id === query.periodo)
      ? query.periodo
      : null) ??
    currentWeek?.id ??
    weekOptions[0]?.id ??
    null;

  const [week, breakdown, history, rankHistory, payments] = await Promise.all([
    weekId ? getWeekDetail(weekId) : Promise.resolve(null),
    weekId
      ? getStaffWeekBreakdown(member.id, weekId, true)
      : Promise.resolve({ entries: [], totalMinutes: 0, voidedMinutes: 0 }),
    getStaffHistory(member.id),
    getStaffRankHistory(member.id),
    can(PERMISSIONS.PAYMENTS_VIEW) ? getStaffPayments(member.id) : Promise.resolve([]),
  ]);

  const periodRecord = history.find((row) => row.weekId === weekId);
  const accent = CATEGORY_ACCENT[member.category as StaffCategory];
  const calculation = periodRecord
    ? explainCalculation(periodRecord.totalMinutes, periodRecord.hourlyRate)
    : null;

  const totalHistoricMinutes = history.reduce((sum, row) => sum + row.totalMinutes, 0);
  const totalHistoricAmount = history.reduce((sum, row) => sum + row.amount, 0);
  const totalPaid = payments
    .filter((payment) => payment.voidedAt === null)
    .reduce((sum, payment) => sum + payment.amount, 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          href="/staff"
          className="text-chalk-500 hover:text-imperial-400 mb-3 inline-flex items-center gap-1.5 text-xs font-semibold transition"
        >
          ← Volver al staff
        </Link>
        <PageHeader
          eyebrow={rankLabel(member.rank)}
          title={member.name}
          description={
            member.archivedAt
              ? "Miembro archivado. Su historial se conserva completo."
              : (member.discordTag ? "Discord: " + member.discordTag + " · " : "") +
                (member.joinedAt ? "En el staff desde " + formatCalendarDate(member.joinedAt) : "")
          }
          actions={<WeekSelector weeks={weekOptions} currentId={weekId} />}
        />
      </div>

      {member.archivedAt ? (
        <Callout tone="warning" title="Miembro archivado">
          {member.archiveReason ?? "Sin motivo registrado."}
        </Callout>
      ) : null}

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Rango actual"
          value={<span className={accent?.fg}>{member.rank}</span>}
          hint={rankLabel(member.rank)}
        />
        <Stat
          label="Horas del período"
          value={formatMinutes(breakdown.totalMinutes)}
          hint={breakdown.entries.filter((entry) => !entry.voidedAt).length + " turnos"}
        />
        <Stat
          label="Le corresponde"
          value={periodRecord ? formatMoney(periodRecord.amount) : "—"}
          hint={periodRecord ? formatMoneyCompact(periodRecord.hourlyRate) + "/h" : undefined}
          accent
        />
        <Stat
          label="Histórico acumulado"
          value={formatMinutes(totalHistoricMinutes)}
          hint={formatMoney(totalHistoricAmount) + " generados"}
        />
      </div>

      {/* Cómo se llegó al importe */}
      {calculation && week ? (
        <Card>
          <CardHeader
            title="Cómo se calcula este importe"
            description="Todo el cálculo es entero y verificable a mano."
          />
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4 text-sm">
            <div>
              <p className="overline">Período</p>
              <p className="text-chalk-100 mt-0.5 font-medium">
                {formatPeriodLabel(week.startDate, week.endDate)}
              </p>
            </div>
            <div>
              <p className="overline">Rango en el período</p>
              <p className="text-chalk-100 mt-0.5 font-medium">{periodRecord?.rank}</p>
            </div>
            <div>
              <p className="overline">Tarifa congelada</p>
              <p className="tnum text-chalk-100 mt-0.5 font-medium">
                {formatMoney(calculation.rate)}/h
              </p>
            </div>
            <div>
              <p className="overline">Cálculo</p>
              <p className="mono tnum text-chalk-300 mt-0.5">{calculation.formatted}</p>
            </div>
            <div className="ml-auto">
              <p className="overline">Total</p>
              <p className="tnum text-imperial-400 mt-0.5 text-lg font-bold">
                {formatMoney(calculation.amount)}
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Turnos del período */}
        <Card>
          <CardHeader
            title="Turnos del período"
            description="Las entradas que explican el total de arriba."
          />
          {breakdown.entries.length === 0 ? (
            <EmptyState icon={<Icon name="clock" size={20} />} title="Sin turnos en este período" />
          ) : (
            <ul className="stagger divide-y divide-white/[0.05]">
              {breakdown.entries.map((entry) => (
                <li
                  key={entry.id}
                  className={
                    "flex items-start justify-between gap-3 px-4 py-2.5 " +
                    (entry.voidedAt ? "opacity-45" : "")
                  }
                >
                  <div className="min-w-0">
                    <p className="text-chalk-200 text-sm">
                      <span className="tnum text-chalk-100 font-semibold">
                        {formatCalendarDate(entry.workDate)}
                      </span>
                      <span className="text-chalk-700 mx-2">·</span>
                      <span className="tnum text-imperial-400 font-semibold">
                        {formatMinutes(entry.minutes)}
                      </span>
                      {entry.voidedAt ? (
                        <Badge tone="imperial" className="ml-2">
                          Anulada
                        </Badge>
                      ) : null}
                    </p>
                    <p className="text-chalk-500 mt-0.5 truncate text-xs">{entry.reason}</p>
                    {entry.voidReason ? (
                      <p className="text-imperial-400/80 mt-0.5 text-[0.6875rem]">
                        Anulada: {entry.voidReason}
                      </p>
                    ) : null}
                  </div>
                  <span className="text-chalk-600 shrink-0 text-[0.6875rem]">
                    por {entry.recordedByUsername}
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between gap-3 bg-white/[0.02] px-4 py-2.5">
                <span className="text-chalk-400 text-xs font-semibold">Total del período</span>
                <span className="tnum text-chalk-50 text-sm font-bold">
                  {formatMinutes(breakdown.totalMinutes)}
                </span>
              </li>
            </ul>
          )}
        </Card>

        {/* Evolución histórica */}
        <Card>
          <CardHeader
            title="Evolución histórica"
            description="Horas por período, del más viejo al más reciente."
          />
          <div className="p-4">
            {history.length >= 2 ? (
              <LineChart
                format="minutes"
                data={[...history].reverse().map((row) => ({
                  label: formatCalendarDateShort(row.startDate),
                  value: row.totalMinutes,
                }))}
              />
            ) : (
              <p className="text-chalk-600 py-10 text-center text-xs">
                Hacen falta al menos dos períodos para ver una evolución.
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Historial por período */}
      <Card>
        <CardHeader
          title="Historial por período"
          description="Cada fila muestra el rango y la tarifa que regían en ese momento."
        />
        {history.length === 0 ? (
          <EmptyState icon={<Icon name="history" size={20} />} title="Sin historial todavía" />
        ) : (
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Período</th>
                  <th>Estado</th>
                  <th>Rango</th>
                  <th className="text-right">Tarifa</th>
                  <th className="text-right">Horas</th>
                  <th className="text-right">Importe</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {history.map((row) => (
                  <tr key={row.weekId}>
                    <td>
                      <Link
                        href={"/staff/" + member.id + "?periodo=" + row.weekId}
                        className="text-chalk-200 hover:text-imperial-400 text-xs font-medium transition"
                      >
                        {formatPeriodLabel(row.startDate, row.endDate)}
                      </Link>
                    </td>
                    <td>
                      <Badge tone={row.status === "open" ? "amber" : "muted"} dot>
                        {row.status === "open" ? "Abierto" : "Cerrado"}
                      </Badge>
                    </td>
                    <td className="text-chalk-300 text-xs font-semibold">{row.rank}</td>
                    <td className="tnum text-chalk-500 text-right text-xs">
                      {formatMoneyCompact(row.hourlyRate)}/h
                    </td>
                    <td className="tnum text-right font-semibold">
                      {formatMinutes(row.totalMinutes)}
                    </td>
                    <td className="tnum text-chalk-100 text-right font-semibold">
                      {formatMoney(row.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Pagos */}
        {can(PERMISSIONS.PAYMENTS_VIEW) ? (
          <Card>
            <CardHeader
              title="Pagos recibidos"
              description={"Total cobrado: " + formatMoney(totalPaid)}
            />
            {payments.length === 0 ? (
              <EmptyState icon={<Icon name="wallet" size={20} />} title="Sin pagos registrados" />
            ) : (
              <ul className="stagger divide-y divide-white/[0.05]">
                {payments.map((payment) => (
                  <li
                    key={payment.id}
                    className={
                      "flex items-center justify-between gap-3 px-4 py-2.5 " +
                      (payment.voidedAt ? "opacity-45" : "")
                    }
                  >
                    <div className="min-w-0">
                      <p className="text-chalk-200 text-xs font-medium">
                        {formatPeriodLabel(payment.weekStart, payment.weekEnd)}
                        {payment.voidedAt ? (
                          <Badge tone="imperial" className="ml-2">
                            Anulado
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-chalk-600 mt-0.5 text-[0.6875rem]">
                        {localDateTime(payment.paidAt)} · registrado por {payment.paidByUsername}
                      </p>
                    </div>
                    <span className="tnum text-jade-400 shrink-0 text-sm font-semibold">
                      {formatMoney(payment.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}

        {/* Historial de rangos */}
        <Card>
          <CardHeader title="Historial de rangos" description="Ascensos, descensos y el motivo." />
          {rankHistory.length === 0 ? (
            <EmptyState icon={<Icon name="crown" size={20} />} title="Sin cambios de rango" />
          ) : (
            <ul className="stagger divide-y divide-white/[0.05]">
              {rankHistory.map((change) => (
                <li key={change.id} className="px-4 py-2.5">
                  <p className="text-chalk-200 text-xs">
                    {change.fromRank ? (
                      <>
                        <span className="font-semibold">{change.fromRank}</span>
                        <span className="text-chalk-600 mx-1.5">→</span>
                      </>
                    ) : null}
                    <span className="text-imperial-400 font-semibold">{change.toRank}</span>
                    <Badge
                      tone={
                        change.changeType === "ascenso"
                          ? "jade"
                          : change.changeType === "descenso"
                            ? "imperial"
                            : "muted"
                      }
                      className="ml-2"
                    >
                      {change.changeType}
                    </Badge>
                  </p>
                  {change.reason ? (
                    <p className="text-chalk-500 mt-0.5 text-[0.6875rem]">{change.reason}</p>
                  ) : null}
                  <p className="text-chalk-600 mt-0.5 text-[0.6875rem]">
                    {localDateShort(change.createdAt)} · {change.changedByUsername}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {member.notes ? (
        <Card>
          <CardHeader title="Notas" />
          <p className="text-chalk-300 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
            {member.notes}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
