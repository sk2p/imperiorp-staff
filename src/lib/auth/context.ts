import { headers } from "next/headers";
import { cache } from "react";

import type { Session, User } from "@/db/schema";
import { forbidden, unauthenticated } from "@/lib/core/errors";
import { newTraceId } from "@/lib/core/logger";
import {
  effectivePermissions,
  hasFullAccess,
  hasPermission,
  type Permission,
  type UserRole,
} from "@/domain/permissions";
import { getCurrentSession } from "./session";

/**
 * IMPERIO RP — Punto único de autorización.
 *
 * TODA comprobación de permisos del sistema pasa por acá y se ejecuta en el
 * servidor. El front puede ocultar un botón por comodidad, pero jamás es la
 * defensa: la defensa es esta función, que se invoca antes de cada operación.
 */

/** Datos del usuario aptos para viajar al cliente. Sin hash ni campos internos. */
export interface Viewer {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: UserRole | string;
  readonly permissions: readonly Permission[];
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly sessionId: string;
}

/** Quién ejecuta una operación, con la traza para auditarla. */
export interface ActorContext {
  /**
   * Nulo cuando actúa el propio sistema (la rotación automática de período).
   * No se puede inventar un identificador: la auditoría tiene clave foránea
   * contra usuarios, y un id falso rompería la inserción.
   */
  readonly id: string | null;
  readonly username: string;
  readonly role: string;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  readonly traceId: string;
  readonly sessionId: string;
}

export interface AuthContext {
  readonly user: User;
  readonly session: Session;
  readonly actor: ActorContext;
  readonly viewer: Viewer;
  readonly can: (permission: Permission) => boolean;
}

/* -------------------------------------------------------------------------- */
/* Extracción de metadatos de red                                             */
/* -------------------------------------------------------------------------- */

/**
 * Sólo se confía en la primera entrada de `x-forwarded-for` cuando hay un proxy
 * delante (Railway, Render, Fly, Vercel, nginx). Esa IP se usa para auditar y
 * para limitar intentos, nunca para autorizar.
 */
export async function requestMetadata(): Promise<{
  ip: string | undefined;
  userAgent: string | undefined;
}> {
  try {
    const headerList = await headers();
    const forwarded = headerList.get("x-forwarded-for");
    const ip =
      forwarded?.split(",")[0]?.trim() ||
      headerList.get("x-real-ip")?.trim() ||
      headerList.get("cf-connecting-ip")?.trim() ||
      undefined;

    return {
      ip: ip?.slice(0, 45),
      userAgent: headerList.get("user-agent")?.slice(0, 512) ?? undefined,
    };
  } catch {
    return { ip: undefined, userAgent: undefined };
  }
}

/* -------------------------------------------------------------------------- */
/* Lectura del contexto                                                       */
/* -------------------------------------------------------------------------- */

function toViewer(user: User, sessionId: string): Viewer {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    role: user.role,
    permissions: [...effectivePermissions(user)],
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    sessionId,
  };
}

/**
 * `cache` de React deduplica la validación dentro de un mismo render: el layout
 * y cinco componentes pueden pedir el contexto sin generar cinco consultas.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const sessionContext = await getCurrentSession();
  if (!sessionContext) return null;

  const { user, session } = sessionContext;
  const metadata = await requestMetadata();
  const permissions = effectivePermissions(user);

  return {
    user,
    session,
    viewer: toViewer(user, session.id),
    actor: {
      id: user.id,
      username: user.username,
      role: user.role,
      ip: metadata.ip,
      userAgent: metadata.userAgent,
      traceId: newTraceId(),
      sessionId: session.id,
    },
    can: (permission: Permission) => hasFullAccess(user.role) || permissions.has(permission),
  };
});

/** Contexto o excepción. Es el punto de entrada de toda operación autenticada. */
export async function requireAuth(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) throw unauthenticated();
  return context;
}

/**
 * Exige un permiso concreto. Falla cerrado: cualquier duda termina en 403.
 */
export async function requirePermission(permission: Permission): Promise<AuthContext> {
  const context = await requireAuth();

  if (!hasPermission(context.user, permission)) {
    throw forbidden("No tenés permiso para esta acción. Requiere: " + permission + ".", {
      context: { username: context.user.username, role: context.user.role, permission },
    });
  }

  return context;
}

/** Variante para operaciones que aceptan cualquiera de varios permisos. */
export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<AuthContext> {
  const context = await requireAuth();

  const granted = permissions.some((permission) => hasPermission(context.user, permission));
  if (!granted) {
    throw forbidden("No tenés permiso para esta acción.", {
      context: { username: context.user.username, required: permissions },
    });
  }

  return context;
}

/** Sólo OWNER. Reservado para lo verdaderamente irreversible. */
export async function requireOwner(): Promise<AuthContext> {
  const context = await requireAuth();
  if (!hasFullAccess(context.user.role)) {
    throw forbidden("Esta acción está reservada al Owner del sistema.");
  }
  return context;
}

/**
 * Sólo el Fundador.
 *
 * Reservado a la administración de cuentas del panel: ver quién tiene acceso
 * y poder restablecer contraseñas ajenas queda en una sola mano, no en todas
 * las que tengan rol Owner.
 */
export async function requireFounder(): Promise<AuthContext> {
  const context = await requireAuth();
  if (context.user.role !== "FOUNDER") {
    throw forbidden("La gestión de usuarios del panel está reservada al Fundador.");
  }
  return context;
}

/** Viewer actual o . Para componentes que se adaptan sin exigir sesión. */
export async function getViewer(): Promise<Viewer | null> {
  const context = await getAuthContext();
  return context?.viewer ?? null;
}

/**
 * Actor que representa al propio sistema.
 *
 * Lo usan las tareas programadas. Queda registrado en la auditoría como
 * "sistema", así que un cierre automático se distingue a simple vista de uno
 * hecho por una persona.
 */
export function systemActor(reason: string): ActorContext {
  return {
    id: null,
    username: "sistema",
    role: "SYSTEM",
    ip: undefined,
    userAgent: reason,
    traceId: newTraceId(),
    sessionId: "sistema",
  };
}
