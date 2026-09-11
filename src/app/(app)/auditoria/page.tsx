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
import { requirePermission } from "@/lib/auth/context";
import { listAuditActors, listAuditLogs, verifyAuditChain } from "@/server/audit";
import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS, auditFiltersSchema } from "@/validation/system";

export const metadata: Metadata = { title: "Auditoría" };
export const dynamic = "force-dynamic";

/** Muestra un valor de `before`/`after` de forma legible. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ChangeTable({
  before,
  after,
  fields,
}: {
  readonly before: unknown;
  readonly after: unknown;
  readonly fields: readonly string[] | null;
}) {
  const beforeRecord = (before ?? {}) as Record<string, unknown>;
  const afterRecord = (after ?? {}) as Record<string, unknown>;
  const keys =
    fields && fields.length > 0
      ? fields
      : [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])];

  if (keys.length === 0) return null;

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-white/[0.08]">
      <table className="w-full text-[0.6875rem]">
        <tbody>
          {keys.slice(0, 8).map((key) => (
            <tr key={key} className="border-b border-white/[0.05] last:border-0">
              <td className="text-chalk-500 w-32 bg-white/[0.02] px-2.5 py-1.5 font-semibold">
                {key}
              </td>
              <td className="text-imperial-400/80 px-2.5 py-1.5 line-through">
                {renderValue(beforeRecord[key])}
              </td>
              <td className="text-jade-400 px-2.5 py-1.5">{renderValue(afterRecord[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission(PERMISSIONS.AUDIT_VIEW);
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
        description="Quién hizo qué, cuándo, con qué valores antes y después, y por qué."
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
        <CardHeader title="Registro de acciones" />
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
            <ul className="stagger divide-y divide-white/[0.05]">
              {logs.items.map((log) => (
                <li key={log.id} className="row-rail px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="imperial">
                          {AUDIT_ACTION_LABELS[log.action as keyof typeof AUDIT_ACTION_LABELS] ??
                            log.action}
                        </Badge>
                        <span className="text-chalk-100 text-sm font-medium">{log.summary}</span>
                      </div>
                      <p className="text-chalk-600 mt-1 text-[0.6875rem]">
                        <span className="text-chalk-400 font-semibold">{log.actorUsername}</span>
                        {" · "}
                        {log.createdAt.toLocaleString("es-AR", {
                          dateStyle: "short",
                          timeStyle: "medium",
                        })}
                        {log.ip ? " · " + log.ip : ""}
                        {" · #" + log.sequence}
                      </p>
                      {log.reason ? (
                        <p className="border-imperial-500/40 text-chalk-300 mt-1.5 rounded-md border-l-2 bg-white/[0.02] px-2.5 py-1.5 text-xs">
                          {log.reason}
                        </p>
                      ) : null}
                      {log.before || log.after ? (
                        <ChangeTable
                          before={log.before}
                          after={log.after}
                          fields={log.changedFields}
                        />
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
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
