import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { BarChart, ProgressMeter } from "@/components/ui/charts";
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
  Stat,
} from "@/components/ui/primitives";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { localDate } from "@/domain/clock";
import { formatCalendarDateShort, formatPeriodLabel } from "@/domain/periods";
import { CATEGORY_ACCENT, type StaffCategory } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import { requireAuth } from "@/lib/auth/context";
import { PERMISSIONS } from "@/domain/permissions";
import { getWeeklyLines, listRecentHourEntries } from "@/server/hours";
import { getPaymentSummary, listRecentPayments } from "@/server/payments";
import { getGlobalStats, getWeekSeries } from "@/server/stats";
import { getCurrentWeek } from "@/server/weeks";

export const dynamic = "force-dynamic";

/** Relativiza una fecha: "hace 5 min", "hace 2 h", "ayer". */
function relativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "recién";
  if (seconds < 3600) return "hace " + Math.floor(seconds / 60) + " min";
  if (seconds < 86_400) return "hace " + Math.floor(seconds / 3600) + " h";
  if (seconds < 172_800) return "ayer";
  return "hace " + Math.floor(seconds / 86_400) + " días";
}

export default async function DashboardPage() {
  const { viewer, can } = await requireAuth();

  const week = await getCurrentWeek();

  /**
   * ¿El período que la pantalla llama "activo" contiene el día de hoy?
   *
   * No siempre. Si el período de esta semana se borró, o si el siguiente se
   * creó arrancando el sábado, el más reciente abierto puede no haber empezado
   * todavía. Y eso importa mucho más de lo que parece: un fichaje se anota en
   * el período cuyas fechas CONTIENEN el día trabajado, así que si hoy no cae
   * en ninguno, las horas de hoy no tienen dónde anotarse. El bot avisa a quien
   * ficha, pero nadie más se entera.
   */
  const hoy = localDate();
  const hoyEstaCubierto = week !== null && week.startDate <= hoy && hoy <= week.endDate;

  const [stats, series, lines, payments, recentHours, recentPayments] = await Promise.all([
    getGlobalStats(),
    getWeekSeries(10),
    week ? getWeeklyLines(week.id) : Promise.resolve([]),
    week ? getPaymentSummary(week.id) : Promise.resolve(null),
    can(PERMISSIONS.HOURS_VIEW) ? listRecentHourEntries(6) : Promise.resolve([]),
    can(PERMISSIONS.PAYMENTS_VIEW) ? listRecentPayments(5) : Promise.resolve([]),
  ]);

  const periodMinutes = lines.reduce((sum, line) => sum + line.totalMinutes, 0);
  const periodAmount = lines.reduce((sum, line) => sum + line.amount, 0);
  const withHours = lines.filter((line) => line.totalMinutes > 0).length;
  const topLines = [...lines].filter((line) => line.totalMinutes > 0).slice(0, 8);

  const hour = new Date().getHours();
  const greeting =
    hour < 6
      ? "Buenas noches"
      : hour < 13
        ? "Buenos días"
        : hour < 20
          ? "Buenas tardes"
          : "Buenas noches";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={greeting + ", " + viewer.displayName}
        title={
          week
            ? "Período " + formatPeriodLabel(week.startDate, week.endDate)
            : "Sin período abierto"
        }
        description={
          week
            ? hoyEstaCubierto
              ? "Este es el período activo. Todo lo que se registre hoy entra acá."
              : "Es el período abierto más próximo, pero hoy no cae adentro."
            : "Todavía no hay un período abierto. Creá uno para empezar a cargar horas."
        }
        actions={
          <>
            {can(PERMISSIONS.HOURS_CREATE) && week ? (
              <LinkButton href="/horas" size="sm">
                <Icon name="plus" size={15} />
                Cargar horas
              </LinkButton>
            ) : null}
            {can(PERMISSIONS.WEEKS_CREATE) && !week ? (
              <LinkButton href="/periodos" size="sm">
                <Icon name="plus" size={15} />
                Abrir período
              </LinkButton>
            ) : null}
          </>
        }
      />

      {!week ? (
        <Callout tone="warning" title="No hay ningún período abierto">
          Las horas siempre pertenecen a un período. Sin uno abierto no se puede registrar nada
          nuevo, aunque el historial anterior sigue disponible y consultable.
        </Callout>
      ) : null}

      {week && !hoyEstaCubierto ? (
        <Callout tone="warning" title="Hoy no cae dentro de ningún período abierto">
          El período más próximo va del {formatCalendarDateShort(week.startDate)} al{" "}
          {formatCalendarDateShort(week.endDate)}, y hoy es {formatCalendarDateShort(hoy)}. Un
          fichaje se anota en el período que contiene el día trabajado: mientras siga así, lo que se
          fiche hoy queda sin registrar en ninguna planilla.
          {can(PERMISSIONS.WEEKS_CREATE)
            ? " Creá un período que incluya el día de hoy, o corregí las fechas del que está abierto."
            : " Avisale a pit o a mati."}
        </Callout>
      ) : null}

      {/* Métricas del período activo */}
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Horas del período"
          value={formatMinutes(periodMinutes)}
          hint={withHours + " de " + lines.length + " miembros con actividad"}
          icon={<Icon name="clock" size={16} />}
        />
        <Stat
          label="Generado"
          value={formatMoneyCompact(periodAmount)}
          hint={formatMoney(periodAmount)}
          accent
          icon={<Icon name="wallet" size={16} />}
        />
        <Stat
          label="Pendiente de pago"
          value={payments ? formatMoneyCompact(payments.pendingAmount) : "—"}
          hint={
            payments ? payments.pendingCount + " liquidación(es) sin pagar" : "Se calcula al cerrar"
          }
          icon={<Icon name="alert" size={16} />}
        />
        <Stat
          label="Staff activo"
          value={stats.activeStaff}
          /**
           * El promedio es de ESTE período, no el histórico de todos.
           *
           * Decía el histórico, y quedaba abajo de tres indicadores que hablan
           * del período en curso: alguien leía "promedio 13h 52m" al lado de
           * "horas del período: 0h" y no había forma de que eso cerrara. Los
           * dos números eran ciertos y ninguno de los dos era el que se estaba
           * leyendo.
           */
          hint={
            withHours === 0
              ? "Sin horas cargadas todavía"
              : "Promedio " +
                formatMinutes(Math.round(periodMinutes / withHours)) +
                " entre los " +
                withHours +
                " que cargaron"
          }
          icon={<Icon name="users" size={16} />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Ranking del período */}
        <Card className="lg:col-span-2">
          <CardHeader
            title="Horas del período en curso"
            description={
              week
                ? "Ordenado de mayor a menor. Los importes se calculan con la tarifa vigente."
                : undefined
            }
            action={
              can(PERMISSIONS.HOURS_VIEW) ? (
                <Link
                  href="/horas"
                  className="text-chalk-400 hover:text-imperial-400 text-xs font-semibold transition"
                >
                  Ver todo →
                </Link>
              ) : null
            }
          />
          {topLines.length === 0 ? (
            <EmptyState
              icon={<Icon name="clock" size={20} />}
              title="Todavía no hay horas cargadas"
              description="Apenas se registre el primer turno vas a ver acá el reparto del período."
              action={
                can(PERMISSIONS.HOURS_CREATE) && week ? (
                  <LinkButton href="/horas" size="sm" variant="secondary">
                    Cargar el primer turno
                  </LinkButton>
                ) : null
              }
            />
          ) : (
            <ul className="stagger divide-y divide-white/[0.05]">
              {topLines.map((line, index) => {
                const accent = CATEGORY_ACCENT[line.category as StaffCategory];
                const share = periodMinutes > 0 ? (line.totalMinutes / periodMinutes) * 100 : 0;

                return (
                  <li key={line.recordId} className="row-rail flex items-center gap-3 px-4 py-2.5">
                    <span className="tnum text-chalk-600 w-5 shrink-0 text-center text-xs font-bold">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-chalk-100 truncate text-sm font-medium">{line.name}</p>
                        <span
                          className={
                            "shrink-0 rounded border px-1.5 py-px text-[0.625rem] font-bold " +
                            (accent?.fg ?? "") +
                            " " +
                            (accent?.bg ?? "") +
                            " " +
                            (accent?.border ?? "")
                          }
                        >
                          {line.rank}
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                        <div
                          className="bar-grow bg-imperial-500/70 h-full rounded-full"
                          style={{ width: Math.max(2, share) + "%" }}
                        />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tnum text-chalk-100 text-sm font-semibold">
                        {formatMinutes(line.totalMinutes)}
                      </p>
                      <p className="tnum text-chalk-500 text-[0.6875rem]">
                        {formatMoneyCompact(line.amount)}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Estado de pagos + actividad */}
        <div className="flex flex-col gap-4">
          {payments && can(PERMISSIONS.PAYMENTS_VIEW) ? (
            <Card>
              <CardHeader title="Estado de la liquidación" />
              <div className="flex flex-col gap-4 p-4">
                <ProgressMeter
                  label="Liquidaciones pagadas"
                  value={payments.paidCount}
                  total={payments.paidCount + payments.pendingCount}
                />
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="overline">Pagado</p>
                    <p className="tnum text-jade-400 mt-0.5 text-sm font-semibold">
                      {formatMoneyCompact(payments.paidAmount)}
                    </p>
                  </div>
                  <div>
                    <p className="overline">Pendiente</p>
                    <p className="tnum mt-0.5 text-sm font-semibold text-amber-400">
                      {formatMoneyCompact(payments.pendingAmount)}
                    </p>
                  </div>
                </div>
                {week?.status === "open" ? (
                  <p className="text-chalk-500 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[0.6875rem] leading-relaxed">
                    Los pagos se registran con el período ya cerrado, para que el importe no cambie
                    después de haberse abonado.
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}

          {recentHours.length > 0 ? (
            <Card>
              <CardHeader title="Actividad reciente" />
              <ul className="stagger divide-y divide-white/[0.05]">
                {recentHours.map((entry) => (
                  <li key={entry.id} className="px-4 py-2.5">
                    <p className="text-chalk-300 text-xs leading-relaxed">
                      <span className="text-chalk-100 font-semibold">
                        {entry.recordedByUsername}
                      </span>{" "}
                      cargó{" "}
                      <span className="tnum text-imperial-400 font-semibold">
                        {formatMinutes(entry.minutes)}
                      </span>{" "}
                      a <span className="text-chalk-100 font-medium">{entry.staffName}</span>
                    </p>
                    <p className="text-chalk-600 mt-0.5 text-[0.6875rem]">
                      {entry.reason} · {formatCalendarDateShort(entry.workDate)} ·{" "}
                      {relativeTime(entry.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Evolución */}
        {can(PERMISSIONS.STATS_VIEW) ? (
          <Card className="lg:col-span-2">
            <CardHeader
              title="Evolución por período"
              description="Dinero generado frente a dinero efectivamente pagado."
              action={
                <Link
                  href="/estadisticas"
                  className="text-chalk-400 hover:text-imperial-400 text-xs font-semibold transition"
                >
                  Análisis completo →
                </Link>
              }
            />
            <div className="p-4">
              <BarChart
                format="money"
                secondaryLabel="Pagado"
                data={series.map((point) => ({
                  label: formatCalendarDateShort(point.startDate),
                  value: point.totalAmount,
                  secondary: point.paidAmount,
                  highlight: point.status === "open",
                }))}
              />
            </div>
          </Card>
        ) : null}

        {/* Totales históricos */}
        <Card>
          <CardHeader title="Totales históricos" description="Desde el inicio del registro." />
          <dl className="divide-y divide-white/[0.05]">
            {[
              { label: "Horas acumuladas", value: formatMinutes(stats.totalMinutes) },
              { label: "Dinero generado", value: formatMoney(stats.totalGenerated) },
              { label: "Dinero pagado", value: formatMoney(stats.totalPaid) },
              { label: "Pendiente de pago", value: formatMoney(stats.totalPending) },
              { label: "Períodos cerrados", value: String(stats.weeksClosed) },
              { label: "Pagos registrados", value: String(stats.paymentsCount) },
            ].map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-3 px-4 py-2.5"
              >
                <dt className="text-chalk-500 text-xs">{row.label}</dt>
                <dd className="tnum text-chalk-100 text-sm font-semibold">{row.value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      {recentPayments.length > 0 && can(PERMISSIONS.PAYMENTS_VIEW) ? (
        <Card>
          <CardHeader
            title="Últimos pagos registrados"
            action={
              <Link
                href="/pagos"
                className="text-chalk-400 hover:text-imperial-400 text-xs font-semibold transition"
              >
                Ver pagos →
              </Link>
            }
          />
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Miembro</th>
                  <th>Período</th>
                  <th className="text-right">Importe</th>
                  <th>Registrado por</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {recentPayments.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      <span className="text-chalk-100 font-medium">{payment.staffName}</span>
                      <Badge tone="muted" className="ml-2">
                        {payment.rank}
                      </Badge>
                    </td>
                    <td className="text-chalk-500 text-xs">
                      {formatPeriodLabel(payment.weekStart, payment.weekEnd)}
                    </td>
                    <td className="tnum text-jade-400 text-right font-semibold">
                      {formatMoney(payment.amount)}
                    </td>
                    <td className="text-chalk-400 text-xs">
                      {payment.paidByUsername}
                      <span className="text-chalk-600 ml-1.5">{relativeTime(payment.paidAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
