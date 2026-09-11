import type { Metadata } from "next";

import { Card, CardHeader, PageHeader, Badge } from "@/components/ui/primitives";
import { hasFullAccess, PERMISSION_GROUPS, roleLabel } from "@/domain/permissions";
import { requireAuth } from "@/lib/auth/context";
import { listActiveSessions } from "@/lib/auth/session";
import { ChangePasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Mi cuenta" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { viewer, session } = await requireAuth();
  const sessions = await listActiveSessions(viewer.id);
  const granted = new Set(viewer.permissions);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Mi cuenta"
        title={viewer.displayName}
        description={"Usuario " + viewer.username + " · " + roleLabel(viewer.role)}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Cambiar contraseña"
            description="Al cambiarla se cierran tus otras sesiones abiertas."
          />
          <ChangePasswordForm />
        </Card>

        <Card>
          <CardHeader
            title="Sesiones activas"
            description="Si ves una que no reconocés, cambiá la contraseña."
          />
          <ul className="divide-y divide-white/[0.05]">
            {sessions.map((item) => (
              <li key={item.id} className="px-4 py-2.5">
                <p className="text-chalk-200 text-xs font-medium">
                  {item.ip ?? "IP desconocida"}
                  {item.id === session.id ? (
                    <Badge tone="jade" className="ml-2">
                      Esta sesión
                    </Badge>
                  ) : null}
                </p>
                <p className="text-chalk-600 mt-0.5 truncate text-[0.6875rem]">
                  {item.userAgent ?? "Dispositivo desconocido"}
                </p>
                <p className="text-chalk-600 mt-0.5 text-[0.6875rem]">
                  Última actividad:{" "}
                  {item.lastSeenAt.toLocaleString("es-AR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Tus permisos"
          description="Lo que podés hacer en el panel. Se verifica en el servidor en cada acción."
        />
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.key}>
              <p className="mb-1.5 overline">{group.label}</p>
              <ul className="flex flex-col gap-1">
                {group.permissions.map((permission) => {
                  const has = hasFullAccess(viewer.role) || granted.has(permission.value);
                  return (
                    <li
                      key={permission.value}
                      className={
                        "flex items-center gap-1.5 text-xs " +
                        (has ? "text-chalk-300" : "text-chalk-700 line-through")
                      }
                    >
                      <span className={has ? "text-jade-400" : "text-chalk-700"}>
                        {has ? "✓" : "·"}
                      </span>
                      {permission.label}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
