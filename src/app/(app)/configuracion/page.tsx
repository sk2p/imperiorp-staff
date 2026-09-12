import type { Metadata } from "next";

import { Icon } from "@/components/layout/icons";
import {
  Badge,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui/primitives";
import { formatMoney } from "@/domain/money";
import { PERMISSIONS, ROLE_DEFINITIONS, isUserRole, roleLabel } from "@/domain/permissions";
import { formatPeriodLabel } from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import { requireAnyPermission } from "@/lib/auth/context";
import { getWeekGrid } from "@/server/grid";
import { SECURITY_EVENT_LABELS, listSecurityEvents } from "@/server/security-events";
import { getGroupRates, listRankRates, listRateHistory, listSettings } from "@/server/settings";
import { listUsers } from "@/server/users";
import { getCurrentWeek } from "@/server/weeks";
import type { SecurityEventType } from "@/validation/system";
import { CreateUserDialog, EditUserDialog, ResetPasswordDialog, SettingRow } from "./config-forms";
import { GroupRatesForm, RankColorsForm, RankGroupsPanel, ResetWeekPanel } from "./grid-settings";

export const metadata: Metadata = { title: "Configuración" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { viewer, can, user } = await requireAnyPermission([
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.SETTINGS_RATES,
    PERMISSIONS.USERS_VIEW,
  ]);

  const actorRank = isUserRole(user.role) ? ROLE_DEFINITIONS[user.role].rank : 0;

  /**
   * Las cuentas del panel las administran únicamente los Fundadores —hoy pit y
   * mati, los encargados de la página.
   *
   * Un Owner puede hacer todo lo demás, pero ver la lista de usuarios expone
   * quién tiene acceso y desde cuándo, y permite restablecer contraseñas
   * ajenas y repartir permisos. Eso queda en pocas manos.
   */
  const canManageUsers = user.role === "FOUNDER";

  const week = await getCurrentWeek();

  const [rates, groupRates, rateHistory, settings, users, securityEvents, grid] = await Promise.all(
    [
      listRankRates(),
      getGroupRates(),
      can(PERMISSIONS.SETTINGS_RATES) ? listRateHistory(8) : Promise.resolve([]),
      can(PERMISSIONS.SETTINGS_MANAGE) ? listSettings() : Promise.resolve([]),
      canManageUsers
        ? listUsers({ page: 1, pageSize: 50, status: "all", search: null })
        : Promise.resolve(null),
      can(PERMISSIONS.SECURITY_VIEW)
        ? listSecurityEvents({ page: 1, pageSize: 12, search: null })
        : Promise.resolve(null),
      week ? getWeekGrid(week) : Promise.resolve(null),
    ],
  );

  const colors = rates.map((rate) => ({ rank: rate.rank, color: rate.color }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sistema"
        title="Configuración"
        description="Administrá pagos, colores de rangos y la presentación del registro."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {can(PERMISSIONS.SETTINGS_RATES) ? (
          <Card>
            <CardHeader
              title="Pagos por categoría"
              description="Valor por hora para cada grupo de staff."
            />
            <GroupRatesForm rates={groupRates} />
          </Card>
        ) : null}

        {can(PERMISSIONS.SETTINGS_MANAGE) ? (
          <Card>
            <CardHeader
              title="Colores de rangos"
              description="Elegí el color que tendrá cada rango dentro del registro."
            />
            <RankColorsForm colors={colors} />
          </Card>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Rangos"
            description="Los rangos están agrupados en High Staff, Mid Staff y Low Staff."
          />
          <RankGroupsPanel colors={colors} />
        </Card>

        {can(PERMISSIONS.HOURS_DELETE) ? (
          <Card>
            <CardHeader
              title="Restablecer semana"
              description="Deja todas las horas en 0:00 y elimina los estados de esta semana."
            />
            <ResetWeekPanel
              weekId={week?.id ?? null}
              weekLabel={week ? formatPeriodLabel(week.startDate, week.endDate) : ""}
              loadedHours={formatMinutes(grid?.totalMinutes ?? 0)}
            />
          </Card>
        ) : null}
      </div>

      {rateHistory.length > 0 ? (
        <Card>
          <CardHeader title="Últimos cambios de tarifa" />
          <ul className="divide-y divide-white/[0.05]">
            {rateHistory.map((change) => (
              <li key={change.id} className="text-chalk-500 px-4 py-2 text-[0.6875rem]">
                <span className="text-chalk-300 font-semibold">{change.rank}</span>
                {": "}
                <span className="tnum line-through">
                  {change.previousRate ? formatMoney(change.previousRate) : "—"}
                </span>
                {" → "}
                <span className="tnum text-chalk-200 font-semibold">
                  {formatMoney(change.newRate)}
                </span>
                <span className="text-chalk-700 mx-2">·</span>
                {change.changedByUsername}
                <span className="text-chalk-700 mx-2">·</span>
                {change.createdAt.toLocaleDateString("es-AR")}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {users ? (
        <Card>
          <CardHeader
            title="Usuarios del panel"
            description="Quién entra a la página y qué puede hacer adentro. Nada de esto tiene relación con el rango de staff."
            action={
              can(PERMISSIONS.USERS_CREATE) ? <CreateUserDialog actorRank={actorRank} /> : null
            }
          />
          {users.items.length === 0 ? (
            <EmptyState icon={<Icon name="user" size={20} />} title="Sin usuarios" />
          ) : (
            <div className="scroll-x">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Usuario</th>
                    <th>Rol</th>
                    <th>Estado</th>
                    <th>Último ingreso</th>
                    <th className="text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="stagger">
                  {users.items.map((row) => (
                    <tr key={row.id} className={row.active ? undefined : "opacity-50"}>
                      <td>
                        <span className="text-chalk-100 font-medium">{row.username}</span>
                        {row.displayName ? (
                          <span className="text-chalk-600 ml-2 text-xs">{row.displayName}</span>
                        ) : null}
                        {row.id === viewer.id ? (
                          <Badge tone="sky" className="ml-2">
                            Vos
                          </Badge>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={row.role === "FOUNDER" ? "imperial" : "neutral"}>
                          {roleLabel(row.role)}
                        </Badge>
                        {row.grantedPermissions.length + row.revokedPermissions.length > 0 ? (
                          <span
                            className="text-chalk-600 ml-2 text-[0.625rem] font-semibold"
                            title="Permisos ajustados a mano por encima del rol"
                          >
                            {row.grantedPermissions.length > 0
                              ? "+" + row.grantedPermissions.length
                              : ""}
                            {row.revokedPermissions.length > 0
                              ? " −" + row.revokedPermissions.length
                              : ""}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={row.active ? "jade" : "muted"} dot>
                          {row.active ? "Activo" : "Inactivo"}
                        </Badge>
                      </td>
                      <td className="text-chalk-500 text-xs">
                        {row.lastLoginAt
                          ? row.lastLoginAt.toLocaleString("es-AR", {
                              dateStyle: "short",
                              timeStyle: "short",
                            })
                          : "nunca"}
                      </td>
                      <td>
                        <div className="flex items-center justify-end gap-0.5">
                          {row.id !== viewer.id ? (
                            <>
                              <EditUserDialog user={row} actorRank={actorRank} />
                              <ResetPasswordDialog userId={row.id} username={row.username} />
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      {settings.length > 0 ? (
        <Card>
          <CardHeader title="Ajustes generales" />
          <div className="divide-y divide-white/[0.05]">
            {settings.map((setting) => (
              <SettingRow key={setting.key} setting={setting} />
            ))}
          </div>
        </Card>
      ) : null}

      {securityEvents ? (
        <Card>
          <CardHeader
            title="Eventos de seguridad recientes"
            description="Ingresos, intentos fallidos y bloqueos."
          />
          {securityEvents.items.length === 0 ? (
            <EmptyState icon={<Icon name="shield" size={20} />} title="Sin eventos registrados" />
          ) : (
            <ul className="stagger divide-y divide-white/[0.05]">
              {securityEvents.items.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-chalk-200 text-xs font-medium">
                      {SECURITY_EVENT_LABELS[event.eventType as SecurityEventType] ??
                        event.eventType}
                      {event.username ? (
                        <span className="text-chalk-500 ml-2">{event.username}</span>
                      ) : null}
                    </p>
                    <p className="text-chalk-600 mt-0.5 text-[0.6875rem]">
                      {event.createdAt.toLocaleString("es-AR", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                      {event.ip ? " · " + event.ip : ""}
                    </p>
                  </div>
                  <Badge
                    tone={
                      event.severity === "critical"
                        ? "imperial"
                        : event.severity === "warning"
                          ? "amber"
                          : "muted"
                    }
                  >
                    {event.severity}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {!canManageUsers ? (
        <Callout tone="neutral" title="Usuarios del panel">
          La gestión de cuentas y los permisos de la página están a cargo de <strong>pit</strong> y{" "}
          <strong>mati</strong>. Si necesitás dar de alta a alguien, cambiarle los permisos o
          restablecer una contraseña, pedíselo a alguno de los dos.
        </Callout>
      ) : null}
    </div>
  );
}
