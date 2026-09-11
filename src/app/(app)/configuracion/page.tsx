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
import { requireAnyPermission } from "@/lib/auth/context";
import { listSecurityEvents } from "@/server/security-events";
import { listRankRates, listRateHistory, listSettings } from "@/server/settings";
import { listUsers } from "@/server/users";
import { SECURITY_EVENT_LABELS } from "@/server/security-events";
import type { SecurityEventType } from "@/validation/system";
import {
  CreateUserDialog,
  EditRateDialog,
  EditUserDialog,
  ResetPasswordDialog,
  SettingRow,
} from "./config-forms";

export const metadata: Metadata = { title: "Configuración" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { viewer, can, user } = await requireAnyPermission([
    PERMISSIONS.SETTINGS_MANAGE,
    PERMISSIONS.SETTINGS_RATES,
    PERMISSIONS.USERS_VIEW,
  ]);

  const actorRank = isUserRole(user.role) ? ROLE_DEFINITIONS[user.role].rank : 0;

  const [rates, rateHistory, users, settings, securityEvents] = await Promise.all([
    can(PERMISSIONS.SETTINGS_RATES) ? listRankRates() : Promise.resolve([]),
    can(PERMISSIONS.SETTINGS_RATES) ? listRateHistory(10) : Promise.resolve([]),
    can(PERMISSIONS.USERS_VIEW)
      ? listUsers({ page: 1, pageSize: 50, status: "all", search: null })
      : Promise.resolve(null),
    can(PERMISSIONS.SETTINGS_MANAGE) ? listSettings() : Promise.resolve([]),
    can(PERMISSIONS.SECURITY_VIEW)
      ? listSecurityEvents({ page: 1, pageSize: 15, search: null })
      : Promise.resolve(null),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Sistema"
        title="Configuración"
        description="Tarifas, usuarios del panel y ajustes generales."
      />

      {/* Tarifas */}
      {can(PERMISSIONS.SETTINGS_RATES) ? (
        <Card>
          <CardHeader
            title="Tarifas por rango"
            description="Cambiar una tarifa sólo afecta a los períodos abiertos."
          />
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rango</th>
                  <th>Nombre</th>
                  <th>Categoría</th>
                  <th className="text-right">Tarifa por hora</th>
                  <th className="text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="stagger">
                {rates.map((rate) => (
                  <tr key={rate.rank}>
                    <td className="text-chalk-100 font-bold">{rate.rank}</td>
                    <td className="text-chalk-400 text-xs">{rate.label}</td>
                    <td>
                      <Badge tone="muted">{rate.category}</Badge>
                    </td>
                    <td className="tnum text-imperial-400 text-right font-semibold">
                      {formatMoney(rate.ratePerHour)}
                    </td>
                    <td className="text-right">
                      <EditRateDialog
                        rank={rate.rank}
                        label={rate.label}
                        currentRate={rate.ratePerHour}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rateHistory.length > 0 ? (
            <div className="border-t border-white/[0.07] px-4 py-3">
              <p className="mb-2 overline">Últimos cambios de tarifa</p>
              <ul className="flex flex-col gap-1.5">
                {rateHistory.map((change) => (
                  <li key={change.id} className="text-chalk-500 text-[0.6875rem]">
                    <span className="text-chalk-300 font-semibold">{change.rank}</span>
                    {": "}
                    <span className="tnum line-through">
                      {change.previousRate ? formatMoney(change.previousRate) : "—"}
                    </span>
                    {" → "}
                    <span className="tnum text-chalk-200 font-semibold">
                      {formatMoney(change.newRate)}
                    </span>
                    {" · " + change.changedByUsername}
                    {" · " + change.createdAt.toLocaleDateString("es-AR")}
                    {change.reason ? " · " + change.reason : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* Usuarios */}
      {users ? (
        <Card>
          <CardHeader
            title="Usuarios del panel"
            description="Son cuentas de acceso al sistema. No tienen relación con el rango de staff."
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
                        <Badge tone={row.role === "OWNER" ? "imperial" : "neutral"}>
                          {roleLabel(row.role)}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={row.active ? "jade" : "muted"} dot>
                          {row.active ? "Activo" : "Inactivo"}
                        </Badge>
                        {row.mustChangePassword ? (
                          <Badge tone="amber" className="ml-1.5">
                            Debe cambiar clave
                          </Badge>
                        ) : null}
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
                          {can(PERMISSIONS.USERS_EDIT) && row.id !== viewer.id ? (
                            <EditUserDialog user={row} actorRank={actorRank} />
                          ) : null}
                          {can(PERMISSIONS.USERS_RESET_PASSWORD) && row.id !== viewer.id ? (
                            <ResetPasswordDialog userId={row.id} username={row.username} />
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

      {/* Ajustes */}
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

      {/* Seguridad */}
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

      <Callout tone="neutral" title="Cómo funcionan los permisos">
        El <strong>rol del usuario</strong> define qué puede hacer en este panel. El{" "}
        <strong>rango del staff</strong> (SDP, MOD, ADM…) define la tarifa de esa persona dentro del
        servidor. Son dos cosas distintas y no se mezclan.
      </Callout>
    </div>
  );
}
