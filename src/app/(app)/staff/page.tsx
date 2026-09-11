import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { FilterBar, FilterSelect, Pagination, SearchField } from "@/components/ui/filters";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/primitives";
import { formatMoneyCompact } from "@/domain/money";
import { formatCalendarDate } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { CATEGORY_ACCENT, CATEGORY_LABELS, RANK_LIST, type StaffCategory } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { getRateMap } from "@/server/settings";
import { countStaff, listStaff } from "@/server/staff";
import { getCurrentWeek } from "@/server/weeks";
import { staffFiltersSchema } from "@/validation/staff";
import {
  ArchiveStaffDialog,
  ChangeRankDialog,
  CreateStaffDialog,
  EditStaffDialog,
  RestoreStaffDialog,
} from "./staff-dialogs";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

export default async function StaffPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { can } = await requirePermission(PERMISSIONS.STAFF_VIEW);
  const params = await searchParams;

  const filters = staffFiltersSchema.parse(params);
  const week = await getCurrentWeek();

  const [result, counts, rates] = await Promise.all([
    listStaff(filters, week?.id),
    countStaff(),
    getRateMap(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operación"
        title="Miembros del staff"
        description="El rango define la tarifa. Los miembros no se eliminan: se archivan, y su historial se conserva."
        actions={can(PERMISSIONS.STAFF_CREATE) ? <CreateStaffDialog /> : null}
      />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Activos" value={counts.active} hint="Disponibles para cargar horas" />
        <Stat label="Archivados" value={counts.archived} hint="Historial conservado" />
        <Stat
          label="Período de referencia"
          value={week ? formatCalendarDate(week.startDate) : "—"}
          hint={week ? "Las horas mostradas son de este período" : "Sin período abierto"}
        />
        <Stat label="Rangos configurados" value={RANK_LIST.length} hint="Tres categorías" />
      </div>

      <Card>
        <CardHeader
          title="Listado"
          description={
            week
              ? "Las horas corresponden al período abierto."
              : "Sin período abierto: no se muestran horas."
          }
        />
        <FilterBar>
          <SearchField placeholder="Buscar por nombre, ID o Discord…" />
          <FilterSelect
            paramName="rank"
            label="Rango"
            allLabel="Todos los rangos"
            options={RANK_LIST.map((rank) => ({
              value: rank.rank,
              label: rank.rank + " — " + rank.name,
            }))}
          />
          <FilterSelect
            paramName="category"
            label="Categoría"
            allLabel="Todas las categorías"
            options={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <FilterSelect
            paramName="status"
            label="Estado"
            allLabel="Activos"
            options={[
              { value: "all", label: "Todos" },
              { value: "archived", label: "Archivados" },
            ]}
          />
        </FilterBar>

        {result.items.length === 0 ? (
          <EmptyState
            icon={<Icon name="users" size={20} />}
            title="No hay miembros que coincidan"
            description="Probá con otro filtro, o dá de alta al primer miembro del staff."
            action={can(PERMISSIONS.STAFF_CREATE) ? <CreateStaffDialog /> : null}
          />
        ) : (
          <>
            <div className="scroll-x">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Miembro</th>
                    <th>Rango</th>
                    <th className="text-right">Tarifa</th>
                    <th className="text-right">Horas del período</th>
                    <th>Discord</th>
                    <th className="text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="stagger">
                  {result.items.map((member) => {
                    const accent = CATEGORY_ACCENT[member.category as StaffCategory];
                    const rate = rates.get(member.rank) ?? 0;
                    const row = {
                      id: member.id,
                      name: member.name,
                      rank: member.rank,
                      inGameId: member.inGameId,
                      discordTag: member.discordTag,
                      joinedAt: member.joinedAt,
                      notes: member.notes,
                      version: member.version,
                    };

                    return (
                      <tr key={member.id} className={member.archivedAt ? "opacity-50" : undefined}>
                        <td>
                          <Link
                            href={"/staff/" + member.id}
                            className="text-chalk-100 hover:text-imperial-400 font-medium transition"
                          >
                            {member.name}
                          </Link>
                          {member.archivedAt ? (
                            <Badge tone="muted" className="ml-2">
                              Archivado
                            </Badge>
                          ) : null}
                          {member.inGameId ? (
                            <span className="mono text-chalk-600 ml-2">{member.inGameId}</span>
                          ) : null}
                        </td>
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
                            {member.rank}
                          </span>
                        </td>
                        <td className="tnum text-chalk-500 text-right text-xs">
                          {formatMoneyCompact(rate)}/h
                        </td>
                        <td className="tnum text-right font-semibold">
                          {formatMinutes(member.periodMinutes)}
                          <span className="text-chalk-600 ml-1.5 text-[0.6875rem] font-normal">
                            {member.periodEntries > 0 ? "(" + member.periodEntries + ")" : ""}
                          </span>
                        </td>
                        <td className="text-chalk-500 text-xs">{member.discordTag ?? "—"}</td>
                        <td>
                          <div className="flex items-center justify-end gap-0.5">
                            {member.archivedAt ? (
                              can(PERMISSIONS.STAFF_EDIT) ? (
                                <RestoreStaffDialog member={row} />
                              ) : null
                            ) : (
                              <>
                                {can(PERMISSIONS.STAFF_EDIT) ? (
                                  <EditStaffDialog member={row} />
                                ) : null}
                                {can(PERMISSIONS.STAFF_CHANGE_RANK) ? (
                                  <ChangeRankDialog member={row} />
                                ) : null}
                                {can(PERMISSIONS.STAFF_DELETE) ? (
                                  <ArchiveStaffDialog member={row} />
                                ) : null}
                              </>
                            )}
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
              itemLabel="miembros"
            />
          </>
        )}
      </Card>
    </div>
  );
}
