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
import {
  deleteWeekPreflights,
  listWeeks,
  preflightClose,
  suggestNextPeriodRange,
  weekBreakdowns,
} from "@/server/weeks";
import { weekFiltersSchema } from "@/validation/weeks";
import { GroupBar } from "./period-breakdown";
import { OpenPeriodCard } from "./open-period-card";
import {
  CreatePeriodDialog,
  DeletePeriodDialog,
  EditPeriodDialog,
  ReopenPeriodDialog,
} from "./period-dialogs";

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

  const openWeeks = result.items.filter((week) => week.status === "open");
  const openWeek = openWeeks[0];
  /**
   * El día que se abre el período nuevo sin haber cerrado el viejo quedan dos
   * abiertos. Se muestran todos: el primero es el activo —donde caen las horas
   * de hoy— y los demás siguen teniendo sus horas y su plata adentro.
   */
  /**
   * Todo lo que falta, de una sola vez.
   *
   * Antes eran tres tandas encadenadas: primero los períodos, después las
   * revisiones de cierre, y recién ahí los desgloses. Cada tanda espera a que
   * vuelva la anterior, y contra una base remota cada espera son decenas de
   * milisegundos de pantalla en blanco. Ninguna de estas tres necesita el
   * resultado de las otras: sólo necesitan la lista, que ya está.
   *
   * El chequeo previo al cierre se pide para TODOS los períodos abiertos, no
   * sólo para el primero: cada uno se cierra por su cuenta y tiene sus propias
   * advertencias.
   */
  const ids = result.items.map((week) => week.id);

  const [preflightPares, breakdowns, borrables] = await Promise.all([
    can(PERMISSIONS.WEEKS_CLOSE)
      ? Promise.all(
          openWeeks.map(async (week) => [week.id, await preflightClose(week.id)] as const),
        )
      : Promise.resolve([]),
    weekBreakdowns(ids),
    can(PERMISSIONS.WEEKS_DELETE) ? deleteWeekPreflights(ids) : Promise.resolve(null),
  ]);

  const preflights = new Map(preflightPares);

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

      {openWeeks.length > 0 ? (
        <div className="flex flex-col gap-4">
          {openWeeks.map((week, indice) => (
            <OpenPeriodCard
              key={week.id}
              week={week}
              preflight={preflights.get(week.id) ?? null}
              breakdown={breakdowns.get(week.id)}
              activo={indice === 0}
              puedeCerrar={can(PERMISSIONS.WEEKS_CLOSE)}
            />
          ))}
        </div>
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
                    const desglose = breakdowns.get(week.id);
                    const borrable = borrables?.get(week.id) ?? null;
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
                          {week.notes ? (
                            <span
                              className="text-chalk-700 ml-1.5 text-xs"
                              title={week.notes}
                              aria-label="Tiene notas"
                            >
                              ✎
                            </span>
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
                        <td className="text-right">
                          <span className="tnum font-semibold">
                            {formatMinutes(week.totalMinutes)}
                          </span>
                          {desglose ? (
                            <>
                              <GroupBar breakdown={desglose} className="mt-1 ml-auto w-24" />
                              <span className="text-chalk-600 mt-0.5 block text-[0.625rem]">
                                {desglose.membersWithHours} de {week.memberCount} cargaron
                              </span>
                            </>
                          ) : null}
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
                            {can(PERMISSIONS.WEEKS_CREATE) ? (
                              <EditPeriodDialog
                                weekId={week.id}
                                version={week.version}
                                label={week.label}
                                notes={week.notes}
                                periodLabel={formatPeriodLabel(week.startDate, week.endDate)}
                              />
                            ) : null}
                            {borrable ? (
                              <DeletePeriodDialog
                                weekId={week.id}
                                version={week.version}
                                label={formatPeriodLabel(week.startDate, week.endDate)}
                                blocker={borrable.blocker}
                                canDelete={borrable.canDelete}
                                seededCount={borrable.emptyRecords}
                                markedCount={borrable.markedEntries}
                                cerrado={week.status === "closed"}
                              />
                            ) : null}
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
