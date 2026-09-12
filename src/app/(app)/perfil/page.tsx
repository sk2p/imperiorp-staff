import type { Metadata } from "next";

import { Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { rankLabel } from "@/domain/ranks";
import { requireAuth } from "@/lib/auth/context";
import { listActiveSessions } from "@/lib/auth/session";
import { ChangePasswordForm } from "./password-form";
import { SessionList } from "./sessions";

export const metadata: Metadata = { title: "Mi cuenta" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const { viewer, session } = await requireAuth();
  const sessions = await listActiveSessions(viewer.id);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Mi cuenta"
        title={viewer.displayName}
        description={
          viewer.staffRank
            ? "@" + viewer.username + " · " + rankLabel(viewer.staffRank)
            : "@" + viewer.username
        }
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
            description="Cada dispositivo con tu cuenta abierta. Si ves uno que no reconocés, cerralo."
          />
          <SessionList
            sessions={sessions.map((item) => ({
              id: item.id,
              ip: item.ip,
              userAgent: item.userAgent,
              lastSeenAt: item.lastSeenAt,
              createdAt: item.createdAt,
            }))}
            currentSessionId={session.id}
          />
        </Card>
      </div>
    </div>
  );
}
