import { headers } from "next/headers";
import { cache } from "react";

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { staffMembers, type Session, type User } from "@/db/schema";
import { forbidden, unauthenticated } from "@/lib/core/errors";
import { logger, newTraceId } from "@/lib/core/logger";
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
  /**
   * Rango dentro del servidor, si la cuenta tiene ficha de staff.
   *
   * No es lo mismo que `role`: pit entra como Fundador del panel y es ADM++
   * en Imperio RP. Mostrarle "Fundador" debajo del nombre a todo el que
   * administra la página decía algo falso sobre la jerarquía del servidor.
   */
  readonly staffRank: string | null;
  readonly staffMemberId: string | null;
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

/**
 * Ficha de staff de una cuenta, si la tiene.
 *
 * `cache` la resuelve una sola vez por render, aunque la pidan el armazón y
 * tres pantallas. Es una consulta por índice único, no por nombre.
 */
const staffIdentity = cache(
  async (userId: string): Promise<{ id: string; rank: string } | null> => {
    try {
      const [row] = await db
        .select({ id: staffMembers.id, rank: staffMembers.rank })
        .from(staffMembers)
        .where(and(eq(staffMembers.userId, userId), isNull(staffMembers.archivedAt)))
        .limit(1);
      return row ?? null;
    } catch (error) {
      /**
       * La columna `user_id` la agrega una migración. Entre que se despliega el
       * código y se aplica la migración hay una ventana donde no existe, y esta
       * consulta corre en CADA pantalla con sesión: dejar que reviente sería
       * tirar abajo el panel entero por un adorno debajo del nombre.
       *
       * Sólo se tolera ese error concreto —columna inexistente—, se avisa en el
       * log, y `/api/ready` ya marca el servicio como degradado mientras la
       * migración siga pendiente. Cualquier otro error sale como siempre.
       */
      const code = (error as { code?: unknown }).code;
      if (code !== "42703") throw error;

      logger.warn("staff_members.user_id no existe todavía: falta aplicar una migración");
      return null;
    }
  },
);

function toViewer(
  user: User,
  sessionId: string,
  staff: { id: string; rank: string } | null,
): Viewer {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? user.username,
    role: user.role,
    permissions: [...effectivePermissions(user)],
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    sessionId,
    staffRank: staff?.rank ?? null,
    staffMemberId: staff?.id ?? null,
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
  const [metadata, staff] = await Promise.all([requestMetadata(), staffIdentity(user.id)]);
  const permissions = effectivePermissions(user);

  return {
    user,
    session,
    viewer: toViewer(user, session.id, staff),
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
 * Sesión, y además con la contraseña temporal ya cambiada.
 *
 * La pantalla ya lo imponía —el layout redirige a /cambiar-contrasena—, pero
 * una pantalla no es una defensa: las acciones y las rutas de la API se pueden
 * llamar directo, y la propia página de cambio le da a esa sesión un token
 * anti-CSRF válido. Sin esto, la contraseña temporal —la que viajó por un chat—
 * servía para operar indefinidamente sin cambiarla nunca.
 *
 * Por eso va en todos los `require*` que piden algo más que sesión, y no en
 * `requireAuth`: cambiar la contraseña y cerrar las sesiones propias sólo piden
 * sesión, y tienen que seguir andando justamente en ese estado.
 */
async function requireAuthConContrasenaDefinitiva(): Promise<AuthContext> {
  const contexto = await requireAuth();
  if (contexto.user.mustChangePassword) {
    throw forbidden("Antes de seguir tenés que cambiar la contraseña temporal.", {
      context: { username: contexto.user.username },
    });
  }
  return contexto;
}

/**
 * Exige un permiso concreto. Falla cerrado: cualquier duda termina en 403.
 */
export async function requirePermission(permission: Permission): Promise<AuthContext> {
  const context = await requireAuthConContrasenaDefinitiva();

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
  const context = await requireAuthConContrasenaDefinitiva();

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
  const context = await requireAuthConContrasenaDefinitiva();
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
/**
 * Exige rol de Fundador: hoy, los encargados de la página.
 *
 * Auditoría, Historial y Configuración muestran quién hizo qué, con qué IP y
 * desde cuándo, y permiten repartir accesos. Es información sobre las personas
 * del equipo, no sobre el servidor, así que queda en pocas manos.
 */
export async function requireFounder(seccion = "Esta sección"): Promise<AuthContext> {
  const context = await requireAuthConContrasenaDefinitiva();
  if (context.user.role !== "FOUNDER") {
    throw forbidden(
      seccion + " está reservada a los encargados de la página. Si la necesitás, pedísela a ellos.",
    );
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
