/**
 * IMPERIO RP — Control de acceso granular (RBAC + overrides por usuario).
 *
 * SEPARACIÓN FUNDAMENTAL
 *   · Rol de usuario del sistema  → quién puede usar este panel y hasta dónde.
 *   · Rango de staff (SDP…ADM++)  → posición de la persona dentro del servidor.
 * Son dos ejes independientes y jamás se mezclan.
 *
 * Hoy sólo se usan OWNER y HIGH_STAFF, pero el modelo ya admite roles nuevos y
 * permisos individuales sin tocar ninguna consulta ni ninguna pantalla.
 */

export const PERMISSIONS = {
  // Usuarios del sistema
  USERS_VIEW: "users.view",
  USERS_CREATE: "users.create",
  USERS_EDIT: "users.edit",
  USERS_DELETE: "users.delete",
  USERS_RESET_PASSWORD: "users.reset_password",
  USERS_REVOKE_SESSIONS: "users.revoke_sessions",

  // Miembros del staff
  STAFF_VIEW: "staff.view",
  STAFF_CREATE: "staff.create",
  STAFF_EDIT: "staff.edit",
  STAFF_DELETE: "staff.delete",
  STAFF_CHANGE_RANK: "staff.change_rank",

  // Horas
  HOURS_VIEW: "hours.view",
  HOURS_CREATE: "hours.create",
  HOURS_EDIT: "hours.edit",
  HOURS_DELETE: "hours.delete",

  // Pagos y liquidaciones
  PAYMENTS_VIEW: "payments.view",
  PAYMENTS_CREATE: "payments.create",
  PAYMENTS_EDIT: "payments.edit",
  PAYMENTS_VOID: "payments.void",

  // Períodos
  WEEKS_VIEW: "weeks.view",
  WEEKS_CREATE: "weeks.create",
  WEEKS_CLOSE: "weeks.close",
  WEEKS_REOPEN: "weeks.reopen",
  WEEKS_DELETE: "weeks.delete",

  // Análisis e historial
  STATS_VIEW: "stats.view",
  AUDIT_VIEW: "audit.view",
  SECURITY_VIEW: "security.view",

  // Datos
  DATA_EXPORT: "data.export",
  DATA_IMPORT: "data.import",

  // Sistema
  SETTINGS_MANAGE: "settings.manage",
  SETTINGS_RATES: "settings.rates",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                      */
/* -------------------------------------------------------------------------- */

export const USER_ROLES = ["FOUNDER", "OWNER", "HIGH_STAFF", "MANAGER", "AUDITOR"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Roles con acceso irrestricto. */
export const FULL_ACCESS_ROLES: readonly string[] = ["FOUNDER", "OWNER"];

export function hasFullAccess(role: string | null | undefined): boolean {
  return typeof role === "string" && FULL_ACCESS_ROLES.includes(role);
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

export interface RoleDefinition {
  readonly role: UserRole;
  readonly label: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  /** Sólo un rol de jerarquía estrictamente mayor puede administrar a otro. */
  readonly rank: number;
}

const P = PERMISSIONS;

const MANAGER_PERMISSIONS: readonly Permission[] = [
  P.STAFF_VIEW,
  P.HOURS_VIEW,
  P.HOURS_CREATE,
  P.HOURS_EDIT,
  P.PAYMENTS_VIEW,
  P.WEEKS_VIEW,
  P.STATS_VIEW,
  P.DATA_EXPORT,
];

const HIGH_STAFF_PERMISSIONS: readonly Permission[] = [
  P.USERS_VIEW,
  P.STAFF_VIEW,
  P.STAFF_CREATE,
  P.STAFF_EDIT,
  P.STAFF_DELETE,
  P.STAFF_CHANGE_RANK,
  P.HOURS_VIEW,
  P.HOURS_CREATE,
  P.HOURS_EDIT,
  P.HOURS_DELETE,
  P.PAYMENTS_VIEW,
  P.PAYMENTS_CREATE,
  P.PAYMENTS_EDIT,
  P.WEEKS_VIEW,
  P.WEEKS_CREATE,
  P.WEEKS_CLOSE,
  P.STATS_VIEW,
  P.AUDIT_VIEW,
  P.DATA_EXPORT,
];

export const ROLE_DEFINITIONS: Readonly<Record<UserRole, RoleDefinition>> = {
  FOUNDER: {
    role: "FOUNDER",
    label: "Fundador",
    description:
      "Creador del sistema. Tiene todos los permisos y es el único que puede administrar cuentas Owner.",
    permissions: ALL_PERMISSIONS,
    rank: 200,
  },
  OWNER: {
    role: "OWNER",
    label: "Owner",
    description:
      "Control total del sistema, incluidas la reapertura de períodos, la anulación de pagos y la gestión de usuarios.",
    permissions: ALL_PERMISSIONS,
    rank: 100,
  },
  HIGH_STAFF: {
    role: "HIGH_STAFF",
    label: "High Staff",
    description:
      "Opera el día a día: staff, horas, pagos y cierre de períodos. No puede reabrir períodos ni anular pagos.",
    permissions: HIGH_STAFF_PERMISSIONS,
    rank: 70,
  },
  MANAGER: {
    role: "MANAGER",
    label: "Encargado",
    description: "Carga y corrige horas. Ve pagos y estadísticas, pero no los registra.",
    permissions: MANAGER_PERMISSIONS,
    rank: 40,
  },
  AUDITOR: {
    role: "AUDITOR",
    label: "Auditor",
    description: "Acceso de sólo lectura a todo, incluida la auditoría. No modifica nada.",
    permissions: [
      P.STAFF_VIEW,
      P.HOURS_VIEW,
      P.PAYMENTS_VIEW,
      P.WEEKS_VIEW,
      P.STATS_VIEW,
      P.AUDIT_VIEW,
      P.SECURITY_VIEW,
      P.DATA_EXPORT,
    ],
    rank: 20,
  },
};

export const ROLE_LIST: readonly RoleDefinition[] = Object.values(ROLE_DEFINITIONS).sort(
  (a, b) => b.rank - a.rank,
);

/* -------------------------------------------------------------------------- */
/* Evaluación                                                                 */
/* -------------------------------------------------------------------------- */

export interface PermissionBearer {
  readonly role: string;
  /** Permisos concedidos individualmente, por encima de los del rol. */
  readonly grantedPermissions?: readonly string[] | null;
  /** Permisos revocados individualmente. Tienen prioridad sobre todo, salvo OWNER. */
  readonly revokedPermissions?: readonly string[] | null;
}

/**
 * Resuelve el conjunto efectivo de permisos de un usuario.
 * Orden de precedencia:  OWNER  >  revocados  >  concedidos  >  rol.
 */
export function effectivePermissions(user: PermissionBearer | null | undefined): Set<Permission> {
  if (!user) return new Set();

  if (hasFullAccess(user.role)) return new Set(ALL_PERMISSIONS);

  const definition = isUserRole(user.role) ? ROLE_DEFINITIONS[user.role] : undefined;
  const result = new Set<Permission>(definition?.permissions ?? []);

  for (const granted of user.grantedPermissions ?? []) {
    if (isPermission(granted)) result.add(granted);
  }
  for (const revoked of user.revokedPermissions ?? []) {
    if (isPermission(revoked)) result.delete(revoked);
  }

  return result;
}

export function hasPermission(
  user: PermissionBearer | null | undefined,
  permission: Permission,
): boolean {
  if (!user) return false;
  if (hasFullAccess(user.role)) return true;
  return effectivePermissions(user).has(permission);
}

export function hasAnyPermission(
  user: PermissionBearer | null | undefined,
  permissions: readonly Permission[],
): boolean {
  if (!user) return false;
  if (hasFullAccess(user.role)) return true;
  const effective = effectivePermissions(user);
  return permissions.some((permission) => effective.has(permission));
}

/**
 * Un usuario sólo puede administrar cuentas de jerarquía estrictamente menor.
 * Impide que un HIGH_STAFF se auto-ascienda o toque al OWNER (escalada de privilegios).
 */
export function canManageRole(actorRole: string, targetRole: string): boolean {
  if (!isUserRole(actorRole) || !isUserRole(targetRole)) return false;
  return ROLE_DEFINITIONS[actorRole].rank > ROLE_DEFINITIONS[targetRole].rank;
}

export function roleLabel(role: string): string {
  return isUserRole(role) ? ROLE_DEFINITIONS[role].label : role;
}

/* -------------------------------------------------------------------------- */
/* Agrupación para la pantalla de configuración                               */
/* -------------------------------------------------------------------------- */

export interface PermissionGroup {
  readonly key: string;
  readonly label: string;
  readonly permissions: readonly { readonly value: Permission; readonly label: string }[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    key: "staff",
    label: "Miembros del staff",
    permissions: [
      { value: P.STAFF_VIEW, label: "Ver miembros" },
      { value: P.STAFF_CREATE, label: "Dar de alta" },
      { value: P.STAFF_EDIT, label: "Editar datos" },
      { value: P.STAFF_CHANGE_RANK, label: "Cambiar rango" },
      { value: P.STAFF_DELETE, label: "Archivar" },
    ],
  },
  {
    key: "hours",
    label: "Horas",
    permissions: [
      { value: P.HOURS_VIEW, label: "Ver horas" },
      { value: P.HOURS_CREATE, label: "Registrar horas" },
      { value: P.HOURS_EDIT, label: "Corregir horas" },
      { value: P.HOURS_DELETE, label: "Eliminar entradas" },
    ],
  },
  {
    key: "payments",
    label: "Pagos",
    permissions: [
      { value: P.PAYMENTS_VIEW, label: "Ver pagos" },
      { value: P.PAYMENTS_CREATE, label: "Registrar pagos" },
      { value: P.PAYMENTS_EDIT, label: "Editar pagos" },
      { value: P.PAYMENTS_VOID, label: "Anular pagos" },
    ],
  },
  {
    key: "weeks",
    label: "Períodos",
    permissions: [
      { value: P.WEEKS_VIEW, label: "Ver períodos" },
      { value: P.WEEKS_CREATE, label: "Crear períodos" },
      { value: P.WEEKS_CLOSE, label: "Cerrar períodos" },
      { value: P.WEEKS_REOPEN, label: "Reabrir períodos" },
      { value: P.WEEKS_DELETE, label: "Borrar períodos vacíos" },
    ],
  },
  {
    key: "analysis",
    label: "Análisis y trazabilidad",
    permissions: [
      { value: P.STATS_VIEW, label: "Ver estadísticas" },
      { value: P.AUDIT_VIEW, label: "Ver auditoría" },
      { value: P.SECURITY_VIEW, label: "Ver eventos de seguridad" },
    ],
  },
  {
    key: "data",
    label: "Datos",
    permissions: [
      { value: P.DATA_EXPORT, label: "Exportar" },
      { value: P.DATA_IMPORT, label: "Importar" },
    ],
  },
  {
    key: "users",
    label: "Usuarios del sistema",
    permissions: [
      { value: P.USERS_VIEW, label: "Ver usuarios" },
      { value: P.USERS_CREATE, label: "Crear usuarios" },
      { value: P.USERS_EDIT, label: "Editar usuarios" },
      { value: P.USERS_RESET_PASSWORD, label: "Restablecer contraseñas" },
      { value: P.USERS_REVOKE_SESSIONS, label: "Revocar sesiones" },
      { value: P.USERS_DELETE, label: "Desactivar usuarios" },
    ],
  },
  {
    key: "system",
    label: "Sistema",
    permissions: [
      { value: P.SETTINGS_MANAGE, label: "Configuración general" },
      { value: P.SETTINGS_RATES, label: "Tarifas por rango" },
    ],
  },
];
