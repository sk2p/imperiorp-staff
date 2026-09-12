import type { Metadata } from "next";

import { Card, PageHeader, Stat } from "@/components/ui/primitives";
import { formatMoneyCompact } from "@/domain/money";
import { formatPeriodLabel } from "@/domain/periods";
import { PERMISSIONS } from "@/domain/permissions";
import { formatMinutes } from "@/domain/time";
import { requirePermission } from "@/lib/auth/context";
import { countStaff, getStaffBoard } from "@/server/staff";
import { getCurrentWeek } from "@/server/weeks";
import { StaffCards } from "./staff-cards";
import { CreateStaffDialog } from "./staff-dialogs";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

export default async function StaffPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ archivados?: string }>;
}) {
  const { can } = await requirePermission(PERMISSIONS.STAFF_VIEW);
  const params = await searchParams;
  const includeArchived = params.archivados === "1";

  const week = await getCurrentWeek();
  const [board, counts] = await Promise.all([
    getStaffBoard(week?.id, includeArchived),
    countStaff(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Operación"
        title="Staff"
        description={
          week
            ? "Plantel completo del período " +
              formatPeriodLabel(week.startDate, week.endDate) +
              "."
            : "Plantel completo. Sin período abierto no hay horas que mostrar."
        }
        actions={can(PERMISSIONS.STAFF_CREATE) ? <CreateStaffDialog /> : null}
      />

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Integrantes" value={counts.active} hint="Activos en el staff" />
        <Stat
          label="Horas del período"
          value={formatMinutes(board.totalMinutes)}
          hint="Sólo los días que cuentan"
        />
        <Stat
          label="Total a pagar"
          value={formatMoneyCompact(board.totalAmount)}
          hint="Con las horas cargadas hasta ahora"
        />
        <Stat label="Archivados" value={counts.archived} hint="Historial conservado" />
      </div>

      <StaffCards board={board} can={can} />

      {/* Los archivados no ocupan lugar salvo que se los pida. */}
      {counts.archived > 0 ? (
        <Card>
          <p className="text-chalk-600 px-4 py-3 text-center text-xs">
            {includeArchived ? (
              <a href="/staff" className="hover:text-chalk-300 underline underline-offset-2">
                Ocultar los {counts.archived} archivados
              </a>
            ) : (
              <a
                href="/staff?archivados=1"
                className="hover:text-chalk-300 underline underline-offset-2"
              >
                Ver también los {counts.archived} archivados
              </a>
            )}
          </p>
        </Card>
      ) : null}
    </div>
  );
}
