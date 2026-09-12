"use client";

import { useCallback, useState, useTransition } from "react";

import { Icon } from "@/components/layout/icons";
import { useCsrfToken, useToast } from "@/components/ui/interactive";
import { Badge, Button } from "@/components/ui/primitives";
import { CSRF_FIELD } from "@/lib/auth/csrf";
import { closeOwnSessionAction } from "@/server/actions";

/**
 * Sesiones abiertas de la propia cuenta.
 *
 * Cada línea es un dispositivo con sesión viva. Si aparece una IP o un equipo
 * que no reconocés, el botón la corta en el acto: no hace falta cambiar la
 * contraseña ni pedirle nada a nadie.
 */

export interface SessionRow {
  readonly id: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
}

/** "Chrome en Windows" a partir del user agent, sin librerías ni promesas. */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo desconocido";

  const navegador = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Navegador";

  const sistema = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iPhone o iPad"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "Mac"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "sistema desconocido";

  return navegador + " en " + sistema;
}

export function SessionList({
  sessions,
  currentSessionId,
}: {
  readonly sessions: readonly SessionRow[];
  readonly currentSessionId: string;
}) {
  const token = useCsrfToken();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [closing, setClosing] = useState<string | null>(null);

  const close = useCallback(
    (sessionId: string) => {
      const data = new FormData();
      data.set(CSRF_FIELD, token);
      data.set("sessionId", sessionId);
      setClosing(sessionId);

      startTransition(async () => {
        const result = await closeOwnSessionAction(undefined as never, data);
        setClosing(null);
        if (result.status === "error") toast("error", result.message);
        else if (result.status === "success") toast("success", "Sesión cerrada.");
      });
    },
    [token, toast],
  );

  if (sessions.length === 0) {
    return (
      <p className="text-chalk-600 px-4 py-6 text-center text-xs">
        No hay otras sesiones abiertas.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-white/[0.05]">
      {sessions.map((item) => {
        const isCurrent = item.id === currentSessionId;

        return (
          <li key={item.id} className="flex items-start gap-3 px-4 py-3">
            <span className="bg-ink-800 text-chalk-500 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10">
              <Icon name="shield" size={15} />
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-chalk-200 flex flex-wrap items-center gap-2 text-xs font-medium">
                {describeDevice(item.userAgent)}
                {isCurrent ? <Badge tone="jade">Esta sesión</Badge> : null}
              </p>
              <p className="text-chalk-600 mt-0.5 text-[0.6875rem]">
                {item.ip ?? "IP desconocida"}
                <span className="text-chalk-700 mx-1.5">·</span>
                última actividad{" "}
                {item.lastSeenAt.toLocaleString("es-AR", {
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </p>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending && closing === item.id}
              onClick={() => close(item.id)}
              title={isCurrent ? "Cerrar esta sesión y salir" : "Cerrar esta sesión"}
            >
              {pending && closing === item.id ? "Cerrando…" : isCurrent ? "Salir" : "Cerrar"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
