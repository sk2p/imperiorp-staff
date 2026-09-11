import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { FilterBar, Pagination, SearchField, WeekSelector } from "@/components/ui/filters";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { formatCalendarDate, formatPeriodLabel } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { listHourEntries } from "@/server/hours";
import { listWeeks } from "@/server/weeks";
import { hourFiltersSchema } from "@/validation/hours";

export const metadata: Metadata = { title: "Historial" };
export const dynamic = "force-dynamic";

/** Historial completo: períodos cerrados y todas las cargas de horas. */
export default async function HistoryPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.HOURS_VIEW);
  const params = await searchParams;

  const weekId = typeof params.periodo === "string" ? params.periodo : undefined;

  const filters = hourFiltersSchema.parse({
    ...params,
    weekId,
    includeVoided: "true",
    pageSize: "30",
  });

  const [weeks, entries] = await Promise.all([
    listWeeks({ page: 1, pageSize: 60, status: "all", sortDir: "desc" }),
    listHourEntries(filters),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Análisis"
        title="Historial"
        description="Todo lo registrado, incluidas las entradas anuladas. Nada se pierde."
        actions={
          <WeekSelector
            weeks={[
              {
                id: "",
                startDate: "0000-00-00",
                endDate: "0000-00-00",
                status: "",
                label: "Todos los períodos",
              },
              ...weeks.items,
            ]}
            currentId={weekId ?? ""}
          />
        }
      />

      <Card>
        <CardHeader
          title="Períodos"
          description="Con sus totales congelados y el estado de los pagos."
        />
        {weeks.items.length === 0 ? (
          <EmptyState icon={<Icon name="calendar" size={20} />} title="Sin períodos registrados" />
        ) : (
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
                  <th />
                </tr>
              </thead>
              <tbody className="stagger">
                {weeks.items.map((week) => (
                  <tr key={week.id}>
                    <td className="text-chalk-100 font-medium">
                      {formatPeriodLabel(week.startDate, week.endDate)}
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
                    <td className="tnum text-chalk-400 text-right text-xs">{week.memberCount}</td>
                    <td className="tnum text-right font-semibold">
                      {formatMinutes(week.totalMinutes)}
                    </td>
                    <td className="tnum text-right font-semibold">
                      {formatMoney(week.totalAmount)}
                    </td>
                    <td className="tnum text-jade-400 text-right">
                      {formatMoneyCompact(week.paidAmount)}
                    </td>
                    <td className="text-right">
                      <Link
                        href={"/historial?periodo=" + week.id}
                        className="text-chalk-500 hover:text-imperial-400 text-xs font-semibold transition"
                      >
                        Ver horas →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Todas las cargas de horas"
          description="Incluye las anuladas, con su motivo."
        />
        <FilterBar>
          <SearchField placeholder="Buscar por miembro, motivo o responsable…" />
        </FilterBar>

        {entries.items.length === 0 ? (
          <EmptyState
            icon={<Icon name="history" size={20} />}
            title="Sin registros"
            description="Probá con otro período o con otra búsqueda."
          />
        ) : (
          <>
            <div className="scroll-x">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Miembro</th>
                    <th className="text-right">Duración</th>
                    <th>Motivo</th>
                    <th>Cargado por</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody className="stagger">
                  {entries.items.map((entry) => (
                    <tr key={entry.id} className={entry.voidedAt ? "opacity-50" : undefined}>
                      <td className="tnum text-chalk-400 text-xs whitespace-nowrap">
                        {formatCalendarDate(entry.workDate)}
                      </td>
                      <td className="text-chalk-100 font-medium">
                        {entry.staffName}
                        <Badge tone="muted" className="ml-2">
                          {entry.staffRank}
                        </Badge>
                      </td>
                      <td className="tnum text-right font-semibold">
                        {formatMinutes(entry.minutes)}
                      </td>
                      <td className="text-chalk-400 max-w-[16rem] truncate text-xs">
                        {entry.reason}
                        {entry.voidReason ? (
                          <span className="text-imperial-400/80 block text-[0.6875rem]">
                            Anulada: {entry.voidReason}
                          </span>
                        ) : null}
                      </td>
                      <td className="text-chalk-500 text-xs">{entry.recordedByUsername}</td>
                      <td>
                        {entry.voidedAt ? (
                          <Badge tone="imperial">Anulada</Badge>
                        ) : (
                          <Badge tone="jade">Vigente</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={entries.page}
              pageCount={entries.pageCount}
              total={entries.total}
              itemLabel="registros"
            />
          </>
        )}
      </Card>
    </div>
  );
}
