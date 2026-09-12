import type { Metadata } from "next";

import { Icon } from "@/components/layout/icons";
import { FilterBar, FilterSelect, Pagination, SearchField } from "@/components/ui/filters";
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui/primitives";
import { PERMISSIONS } from "@/domain/permissions";
import { requireFounder, requirePermission } from "@/lib/auth/context";
import { listAuditActors, listAuditLogs, verifyAuditChain } from "@/server/audit";
import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS, auditFiltersSchema } from "@/validation/system";
import { AuditFeed } from "./audit-feed";

export const metadata: Metadata = { title: "Auditoría" };
export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.AUDIT_VIEW);
  // Sección de encargados: ver quién hizo qué queda en pocas manos.
  await requireFounder("La auditoría");
  const params = await searchParams;

  const filters = auditFiltersSchema.parse({ ...params, pageSize: "25" });

  const [logs, actors, integrity] = await Promise.all([
    listAuditLogs(filters),
    listAuditActors(),
    verifyAuditChain(5_000),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Análisis"
        title="Auditoría"
        description="Todo lo que se hace en la página, día por día: quién, qué y por qué."
      />

      <Callout tone={integrity.ok ? "success" : "danger"} title="Integridad del registro">
        {integrity.message}
        {integrity.ok ? (
          <>
            {" "}
            Cada entrada incluye el hash de la anterior: si se borrara o modificara una fila, la
            cadena se rompería y aparecería acá.
          </>
        ) : null}
      </Callout>

      <Card>
        <CardHeader
          title="Registro de acciones"
          description="Lo técnico —valores anteriores, IP, número de orden— está plegado en «Ver detalle»."
        />
        <FilterBar>
          <SearchField placeholder="Buscar por descripción, usuario o motivo…" />
          <FilterSelect
            paramName="action"
            label="Acción"
            allLabel="Todas las acciones"
            options={AUDIT_ACTIONS.map((action) => ({
              value: action,
              label: AUDIT_ACTION_LABELS[action],
            }))}
          />
          <FilterSelect
            paramName="actorId"
            label="Usuario"
            allLabel="Todos los usuarios"
            options={actors.map((actor) => ({ value: actor.id, label: actor.username }))}
          />
        </FilterBar>

        {logs.items.length === 0 ? (
          <EmptyState
            icon={<Icon name="shield" size={20} />}
            title="Sin registros que coincidan"
            description="Probá con otros filtros."
          />
        ) : (
          <>
            <AuditFeed entries={logs.items} />
            <Pagination
              page={logs.page}
              pageCount={logs.pageCount}
              total={logs.total}
              itemLabel="acciones"
            />
          </>
        )}
      </Card>
    </div>
  );
}
