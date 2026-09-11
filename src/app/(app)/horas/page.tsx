import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { FilterBar, Pagination, SearchField, WeekSelector } from "@/components/ui/filters";
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
import { PERMISSIONS } from "@/domain/permissions";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { formatCalendarDate, formatPeriodLabel, formatCalendarDateShort } from "@/domain/periods";
import { CATEGORY_ACCENT, type StaffCategory } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { getWeeklyLines, listHourEntries } from "@/server/hours";
import { listActiveStaffOptions } from "@/server/staff";
import { getCurrentWeek, getWeekDetail, listWeekOptions } from "@/server/weeks";
import { hourFiltersSchema } from "@/validation/hours";
import { EditEntryDialog, VoidEntryDialog } from "./entry-actions";
import { QuickEntry } from "./quick-entry";

export const metadata: Metadata = { title: "Horas" };
export const dynamic = "force-dynamic";

export default async function HoursPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { can } = await requirePermission(PERMISSIONS.HOURS_VIEW);
  const params = await searchParams;

  const weekOptions = await listWeekOptions();
  const requestedWeekId = typeof params.periodo === "string" ? params.periodo : null;
  const fallbackWeek = await getCurrentWeek();
  const weekId =
    (requestedWeekId && weekOptions.some((week) => week.id === requestedWeekId)
      ? requestedWeekId
      : null) ??
    fallbackWeek?.id ??
    weekOptions[0]?.id ??
    null;

  if (!weekId) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Horas" description="Registro y corrección de horas trabajadas." />
        <Card>
          <EmptyState
            icon={<Icon name="calendar" size={20} />}
            title="No hay ningún período creado"
            description="Las horas pertenecen siempre a un período de liquidación. Creá el primero para empezar."
            action={
              can(PERMISSIONS.WEEKS_CREATE) ? (
                <LinkButton href="/periodos" size="sm">
                  Crear período
                </LinkButton>
              ) : null
            }
          />
        </Card>
      </div>
    );
  }

  const filters = hourFiltersSchema.parse({
    ...params,
    weekId,
    page: params.page,
    search: typeof params.search === "string" ? params.search : undefined,
  });

  const [week, lines, entries, staff] = await Promise.all([
    getWeekDetail(weekId),
    getWeeklyLines(weekId),
    listHourEntries({ ...filters, pageSize: 25 }),
    listActiveStaffOptions(),
  ]);

  if (!week) return null;

  const isOpen = week.status === "open";
  const totalMinutes = lines.reduce((sum, line) => sum + line.totalMinutes, 0);
  const totalAmount = lines.reduce((sum, line) => sum + line.amount, 0);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operación"
        title="Horas"
        description="Cada total es la suma de turnos concretos: siempre se puede ver de dónde salió."
        actions={<WeekSelector weeks={weekOptions} currentId={weekId} />}
      />

      {!isOpen ? (
        <Callout tone="warning" title="Este período está cerrado">
          Las horas quedaron congeladas el{" "}
          {week.closedAt ? formatCalendarDate(week.closedAt.toISOString().slice(0, 10)) : "—"}. Para
          modificarlas hay que reabrir el período, lo que exige motivo y permiso de reapertura.
          {can(PERMISSIONS.WEEKS_REOPEN) ? (
            <>
              {" "}
              <Link href="/periodos" className="font-semibold underline underline-offset-2">
                Ir a períodos
              </Link>
            </>
          ) : null}
        </Callout>
      ) : null}

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Período"
          value={
            formatCalendarDateShort(week.startDate) + " → " + formatCalendarDateShort(week.endDate)
          }
          hint={formatPeriodLabel(week.startDate, week.endDate)}
        />
        <Stat
          label="Horas totales"
          value={formatMinutes(totalMinutes)}
          hint={totalMinutes + " minutos"}
        />
        <Stat
          label="Importe"
          value={formatMoneyCompact(totalAmount)}
          hint={formatMoney(totalAmount)}
          accent
        />
        <Stat
          label="Con actividad"
          value={lines.filter((line) => line.totalMinutes > 0).length + " / " + lines.length}
          hint="Miembros con al menos un turno"
        />
      </div>

      {isOpen && can(PERMISSIONS.HOURS_CREATE) && staff.length > 0 ? (
        <Card>
          <CardHeader
            title="Registrar un turno"
            description="Elegí el miembro, tocá una duración y confirmá."
          />
          <QuickEntry
            staff={staff}
            weekId={weekId}
            weekStart={week.startDate}
            weekEnd={week.endDate}
            today={today}
          />
        </Card>
      ) : null}

      {/* Resumen por miembro */}
      <Card>
        <CardHeader
          title="Resumen por miembro"
          description="Liquidación del período con la tarifa aplicada a cada rango."
        />
        {lines.length === 0 ? (
          <EmptyState
            icon={<Icon name="users" size={20} />}
            title="El período no tiene miembros"
            description="Agregá miembros al staff o incorporalos al período desde la pantalla de períodos."
          />
        ) : (
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Miembro</th>
                  <th>Rango</th>
                  <th className="text-right">Horas</th>
                  <th className="text-right">Tarifa</th>
                  <th className="text-right">Importe</th>
                  <th className="text-right">Turnos</th>
                  <th />
                </tr>
              </thead>
              <tbody className="stagger">
                {lines.map((line) => {
                  const accent = CATEGORY_ACCENT[line.category as StaffCategory];
                  return (
                    <tr key={line.recordId}>
                      <td className="text-chalk-100 font-medium">{line.name}</td>
                      <td>
                        <span
                          className={
                            "inline-flex rounded border px-1.5 py-px text-[0.625rem] font-bold " +
                            (accent?.fg ?? "") +
                            " " +
                            (accent?.bg ?? "") +
                            " " +
                            (accent?.border ?? "")
                          }
                        >
                          {line.rank}
                        </span>
                      </td>
                      <td className="tnum text-right font-semibold">
                        {formatMinutes(line.totalMinutes)}
                      </td>
                      <td className="tnum text-chalk-500 text-right text-xs">
                        {formatMoneyCompact(line.hourlyRate)}/h
                      </td>
                      <td className="tnum text-chalk-100 text-right font-semibold">
                        {formatMoney(line.amount)}
                      </td>
                      <td className="tnum text-chalk-500 text-right text-xs">{line.entryCount}</td>
                      <td className="text-right">
                        <Link
                          href={"/staff/" + line.staffMemberId + "?periodo=" + weekId}
                          className="text-chalk-500 hover:text-imperial-400 text-xs font-semibold transition"
                        >
                          Detalle →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10 bg-white/[0.02]">
                  <td colSpan={2} className="text-chalk-400 px-3.5 py-2.5 text-xs font-semibold">
                    Total del período
                  </td>
                  <td className="tnum text-chalk-50 px-3.5 py-2.5 text-right text-sm font-bold">
                    {formatMinutes(totalMinutes)}
                  </td>
                  <td />
                  <td className="tnum text-imperial-400 px-3.5 py-2.5 text-right text-sm font-bold">
                    {formatMoney(totalAmount)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Detalle de turnos */}
      <Card>
        <CardHeader
          title="Turnos registrados"
          description="Cada línea es una carga individual, con su responsable y su motivo."
        />
        <FilterBar>
          <SearchField placeholder="Buscar por miembro, motivo o responsable…" />
        </FilterBar>

        {entries.items.length === 0 ? (
          <EmptyState
            icon={<Icon name="clock" size={20} />}
            title="Sin turnos en este período"
            description="Cuando se registre el primero va a aparecer acá con todo su detalle."
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
                    <th>Qué hizo</th>
                    <th>Cargado por</th>
                    {isOpen && (can(PERMISSIONS.HOURS_EDIT) || can(PERMISSIONS.HOURS_DELETE)) ? (
                      <th className="text-right">Acciones</th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="stagger">
                  {entries.items.map((entry) => (
                    <tr key={entry.id} className={entry.voidedAt ? "opacity-45" : undefined}>
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
                        {entry.voidedAt ? (
                          <Badge tone="imperial" className="ml-2">
                            Anulada
                          </Badge>
                        ) : null}
                      </td>
                      <td
                        className="text-chalk-400 max-w-[18rem] truncate text-xs"
                        title={entry.reason}
                      >
                        {entry.reason}
                      </td>
                      <td className="text-chalk-500 text-xs">{entry.recordedByUsername}</td>
                      {isOpen && (can(PERMISSIONS.HOURS_EDIT) || can(PERMISSIONS.HOURS_DELETE)) ? (
                        <td>
                          <div className="flex items-center justify-end gap-0.5">
                            {!entry.voidedAt && can(PERMISSIONS.HOURS_EDIT) ? (
                              <EditEntryDialog
                                entry={{
                                  id: entry.id,
                                  staffName: entry.staffName,
                                  workDate: entry.workDate,
                                  minutes: entry.minutes,
                                  reason: entry.reason,
                                  version: entry.version,
                                }}
                                weekStart={week.startDate}
                                weekEnd={week.endDate}
                              />
                            ) : null}
                            {!entry.voidedAt && can(PERMISSIONS.HOURS_DELETE) ? (
                              <VoidEntryDialog
                                entry={{
                                  id: entry.id,
                                  staffName: entry.staffName,
                                  workDate: entry.workDate,
                                  minutes: entry.minutes,
                                  reason: entry.reason,
                                  version: entry.version,
                                }}
                              />
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={entries.page}
              pageCount={entries.pageCount}
              total={entries.total}
              itemLabel="turnos"
            />
          </>
        )}
      </Card>
    </div>
  );
}
