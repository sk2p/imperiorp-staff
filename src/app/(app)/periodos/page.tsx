import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { FilterBar, FilterSelect, Pagination } from "@/components/ui/filters";
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
import { formatPeriodLabel, periodLengthInDays } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { listWeeks, preflightClose, suggestNextPeriodRange } from "@/server/weeks";
import { weekFiltersSchema } from "@/validation/weeks";
import { PeriodProgress } from "./period-progress";
import { ClosePeriodDialog, CreatePeriodDialog, ReopenPeriodDialog } from "./period-dialogs";

export const metadata: Metadata = { title: "Períodos" };
export const dynamic = "force-dynamic";

export default async function PeriodsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { can } = await requirePermission(PERMISSIONS.WEEKS_VIEW);
  const params = await searchParams;
  const filters = weekFiltersSchema.parse(params);

  const [result, suggestion] = await Promise.all([listWeeks(filters), suggestNextPeriodRange()]);

  const openWeek = result.items.find((week) => week.status === "open");
  const preflight =
    openWeek && can(PERMISSIONS.WEEKS_CLOSE) ? await preflightClose(openWeek.id) : null;

  const totalGenerated = result.items.reduce((sum, week) => sum + week.totalAmount, 0);
  const totalPaid = result.items.reduce((sum, week) => sum + week.paidAmount, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operación"
        title="Períodos de liquidación"
        description="Cada período define un rango de fechas propio. Al cerrarlo, sus liquidaciones quedan congeladas para siempre."
        actions={
          can(PERMISSIONS.WEEKS_CREATE) ? (
            <CreatePeriodDialog
              suggestedStart={suggestion.startDate}
              suggestedEnd={suggestion.endDate}
            />
          ) : null
        }
      />

      {openWeek ? (
        <Card className="border-imperial-500/25">
          <CardHeader
            title={"Período activo · " + formatPeriodLabel(openWeek.startDate, openWeek.endDate)}
            description={
              periodLengthInDays(openWeek.startDate, openWeek.endDate) +
              " días · " +
              openWeek.memberCount +
              " miembros"
            }
            action={
              preflight && can(PERMISSIONS.WEEKS_CLOSE) ? (
                <ClosePeriodDialog
                  summary={{
                    weekId: openWeek.id,
                    version: openWeek.version,
                    startDate: openWeek.startDate,
                    endDate: openWeek.endDate,
                    totalMinutes: preflight.totalMinutes,
                    totalAmount: preflight.totalAmount,
                    memberCount: preflight.memberCount,
                    membersWithHours: preflight.membersWithHours,
                    warnings: preflight.warnings,
                  }}
                />
              ) : null
            }
          />
          <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
            <div>
              <p className="overline">Horas acumuladas</p>
              <p className="tnum text-chalk-50 mt-1 text-lg font-bold">
                {formatMinutes(openWeek.totalMinutes)}
              </p>
            </div>
            <div>
              <p className="overline">Importe generado</p>
              <p className="tnum text-imperial-400 mt-1 text-lg font-bold">
                {formatMoney(openWeek.totalAmount)}
              </p>
            </div>
            <div>
              <p className="overline">Miembros con horas</p>
              <p className="tnum text-chalk-50 mt-1 text-lg font-bold">
                {preflight ? preflight.membersWithHours : "—"} / {openWeek.memberCount}
              </p>
            </div>
            <div>
              <p className="overline">Advertencias</p>
              <p
                className={
                  "tnum mt-1 text-lg font-bold " +
                  (preflight && preflight.warnings.length > 0 ? "text-amber-400" : "text-jade-400")
                }
              >
                {preflight ? preflight.warnings.length : "—"}
              </p>
            </div>
          </div>

          <PeriodProgress startDate={openWeek.startDate} endDate={openWeek.endDate} />

          {preflight && preflight.warnings.length > 0 ? (
            <div className="border-t border-white/[0.07] px-4 py-3">
              <Callout tone="warning" title="Revisá antes de cerrar">
                <ul className="mt-1 flex flex-col gap-1">
                  {preflight.warnings.slice(0, 4).map((warning, index) => (
                    <li key={index}>· {warning.message}</li>
                  ))}
                  {preflight.warnings.length > 4 ? (
                    <li className="text-chalk-500">
                      y {preflight.warnings.length - 4} advertencia(s) más.
                    </li>
                  ) : null}
                </ul>
              </Callout>
            </div>
          ) : null}
        </Card>
      ) : (
        <Callout tone="warning" title="No hay ningún período abierto">
          Sin un período abierto no se pueden registrar horas nuevas.
          {can(PERMISSIONS.WEEKS_CREATE) ? " Creá uno con el botón de arriba." : ""}
        </Callout>
      )}

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Períodos listados" value={result.total} />
        <Stat
          label="Generado (listado)"
          value={formatMoneyCompact(totalGenerated)}
          hint={formatMoney(totalGenerated)}
        />
        <Stat
          label="Pagado (listado)"
          value={formatMoneyCompact(totalPaid)}
          hint={formatMoney(totalPaid)}
        />
        <Stat
          label="Pendiente"
          value={formatMoneyCompact(Math.max(0, totalGenerated - totalPaid))}
          hint="Sólo de períodos cerrados"
        />
      </div>

      <Card>
        <CardHeader title="Todos los períodos" />
        <FilterBar>
          <FilterSelect
            paramName="status"
            label="Estado"
            allLabel="Todos los estados"
            options={[
              { value: "open", label: "Abiertos" },
              { value: "closed", label: "Cerrados" },
            ]}
          />
        </FilterBar>

        {result.items.length === 0 ? (
          <EmptyState
            icon={<Icon name="calendar" size={20} />}
            title="No hay períodos"
            description="Creá el primero para empezar a registrar horas."
          />
        ) : (
          <>
            <div className="scroll-x">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Período</th>
                    <th>Estado</th>
                    <th className="text-right">Miembros</th>
                    <th className="text-right">Horas</th>
                    <th className="text-right">Generado</th>
                    <th className="text-right">Pagado</th>
                    <th className="text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="stagger">
                  {result.items.map((week) => {
                    const pending = Math.max(0, week.totalAmount - week.paidAmount);
                    return (
                      <tr key={week.id}>
                        <td>
                          <Link
                            href={"/horas?periodo=" + week.id}
                            className="text-chalk-100 hover:text-imperial-400 font-medium transition"
                          >
                            {formatPeriodLabel(week.startDate, week.endDate)}
                          </Link>
                          {week.label ? (
                            <span className="text-chalk-600 ml-2 text-xs">{week.label}</span>
                          ) : null}
                          {week.reopenCount > 0 ? (
                            <Badge tone="amber" className="ml-2">
                              Reabierto ×{week.reopenCount}
                            </Badge>
                          ) : null}
                        </td>
                        <td>
                          <Badge tone={week.status === "open" ? "jade" : "muted"} dot>
                            {week.status === "open" ? "Abierto" : "Cerrado"}
                          </Badge>
                        </td>
                        <td className="tnum text-chalk-400 text-right text-xs">
                          {week.memberCount}
                        </td>
                        <td className="tnum text-right font-semibold">
                          {formatMinutes(week.totalMinutes)}
                        </td>
                        <td className="tnum text-chalk-100 text-right font-semibold">
                          {formatMoney(week.totalAmount)}
                        </td>
                        <td className="tnum text-right">
                          <span className="text-jade-400 font-semibold">
                            {formatMoney(week.paidAmount)}
                          </span>
                          {pending > 0 && week.status === "closed" ? (
                            <span className="block text-[0.6875rem] text-amber-400">
                              faltan {formatMoneyCompact(pending)}
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <div className="flex items-center justify-end gap-1.5">
                            {week.status === "closed" && can(PERMISSIONS.WEEKS_REOPEN) ? (
                              <ReopenPeriodDialog
                                weekId={week.id}
                                version={week.version}
                                label={formatPeriodLabel(week.startDate, week.endDate)}
                                paidCount={week.paidCount}
                              />
                            ) : null}
                            <Link
                              href={"/pagos?periodo=" + week.id}
                              className="text-chalk-500 hover:text-imperial-400 text-xs font-semibold transition"
                            >
                              Pagos →
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              page={result.page}
              pageCount={result.pageCount}
              total={result.total}
              itemLabel="períodos"
            />
          </>
        )}
      </Card>
    </div>
  );
}
