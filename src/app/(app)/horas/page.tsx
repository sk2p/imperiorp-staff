import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { WeekSelector } from "@/components/ui/filters";
import {
  Callout,
  Card,
  CardHeader,
  EmptyState,
  LinkButton,
  PageHeader,
  Stat,
} from "@/components/ui/primitives";
import { DAY_STATUS_LIST } from "@/domain/groups";
import { formatMoney, formatMoneyCompact } from "@/domain/money";
import { PERMISSIONS } from "@/domain/permissions";
import {
  eachDayOfPeriod,
  formatCalendarDateShort,
  formatPeriodLabel,
  weekdayName,
} from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { getWeekGrid } from "@/server/grid";
import { getCurrentWeek, getWeek, listWeekOptions } from "@/server/weeks";
import { WeekGridTable } from "./week-grid";

export const metadata: Metadata = { title: "Registro de Horas" };
export const dynamic = "force-dynamic";

/** "SÁB" a partir de la fecha. */
function shortWeekday(date: string): string {
  return weekdayName(date).slice(0, 3).toUpperCase();
}

export default async function HoursPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ periodo?: string }>;
}) {
  const { can } = await requirePermission(PERMISSIONS.HOURS_VIEW);
  const params = await searchParams;

  const weekOptions = await listWeekOptions();
  const requested =
    params.periodo && weekOptions.some((w) => w.id === params.periodo) ? params.periodo : null;
  const current = await getCurrentWeek();
  const weekId = requested ?? current?.id ?? weekOptions[0]?.id ?? null;

  if (!weekId) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          eyebrow="Operación"
          title="Registro de Horas"
          description="Controlá las horas semanales del staff desde un único panel."
        />
        <Card>
          <EmptyState
            icon={<Icon name="calendar" size={20} />}
            title="Todavía no hay ningún período"
            description="Las horas pertenecen siempre a un período de liquidación. Creá el primero para abrir la planilla."
            action={
              can(PERMISSIONS.WEEKS_CREATE) ? (
                <LinkButton href="/periodos" size="sm">
                  <Icon name="plus" size={15} />
                  Crear período
                </LinkButton>
              ) : null
            }
          />
        </Card>
      </div>
    );
  }

  const week = await getWeek(weekId);
  if (!week) return null;

  const grid = await getWeekGrid(week);
  const dayLabels = eachDayOfPeriod(week.startDate, week.endDate).map((date) => ({
    weekday: shortWeekday(date),
    date: formatCalendarDateShort(date),
  }));

  const isOpen = week.status === "open";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operación"
        title="Registro de Horas"
        description="Controlá las horas semanales del staff desde un único panel."
        actions={
          <>
            <WeekSelector weeks={weekOptions} currentId={weekId} />
            {can(PERMISSIONS.STAFF_CREATE) ? (
              <LinkButton href="/staff" size="sm">
                <Icon name="plus" size={15} />
                Agregar usuario
              </LinkButton>
            ) : null}
          </>
        }
      />

      {!isOpen ? (
        <Callout tone="warning" title="Este período está cerrado">
          Las horas quedaron congeladas y la planilla es de sólo lectura. Para corregir algo hay que
          reabrir el período, lo que exige motivo y un permiso aparte.
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
          label="Horas cargadas"
          value={formatMinutes(grid.totalMinutes)}
          hint="Sólo cuenta a quien cobra"
        />
        <Stat
          label="Paga total"
          value={formatMoneyCompact(grid.totalAmount)}
          hint={formatMoney(grid.totalAmount)}
          accent
        />
        <Stat
          label="Usuarios en la planilla"
          value={grid.memberCount}
          hint={week.label ?? undefined}
        />
      </div>

      <Card>
        <CardHeader
          title="Planilla semanal"
          description={
            isOpen && can(PERMISSIONS.HOURS_EDIT)
              ? "Click en una casilla para cargar horas · Click derecho en la casilla para marcar el día · Click derecho en el rango para cambiarlo"
              : "Vista de sólo lectura."
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              {DAY_STATUS_LIST.filter((status) => status.status !== "normal").map((status) => (
                <span
                  key={status.status}
                  className={
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.625rem] font-semibold " +
                    status.badge
                  }
                >
                  <span className={"h-1.5 w-1.5 rounded-full " + status.dot} />
                  {status.short}
                </span>
              ))}
            </div>
          }
        />

        {grid.groups.length === 0 ? (
          <EmptyState
            icon={<Icon name="users" size={20} />}
            title="La planilla está vacía"
            description="Este período no tiene miembros cargados. Agregá staff y volvé a abrir el período, o incorporalos desde la pantalla de períodos."
            action={
              can(PERMISSIONS.STAFF_CREATE) ? (
                <LinkButton href="/staff" size="sm" variant="secondary">
                  Ir a Staff
                </LinkButton>
              ) : null
            }
          />
        ) : (
          <WeekGridTable
            grid={grid}
            dayLabels={dayLabels}
            canEdit={can(PERMISSIONS.HOURS_EDIT) && isOpen}
            canDelete={can(PERMISSIONS.STAFF_DELETE) && isOpen}
            canReorder={can(PERMISSIONS.STAFF_EDIT)}
            canChangeRank={can(PERMISSIONS.STAFF_CHANGE_RANK) && isOpen}
          />
        )}
      </Card>
    </div>
  );
}
