import { PERMISSIONS, type Permission } from "@/domain/permissions";

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly short: string;
  /** Permisos que habilitan la sección. Basta con tener uno. */
  readonly permissions: readonly Permission[];
  readonly icon: string;
  /** Se muestra en la barra inferior del móvil. */
  readonly primary?: boolean;
}

/**
 * Estructura de navegación.
 *
 * Ocultar un enlace es comodidad, no seguridad: cada página vuelve a exigir su
 * permiso en el servidor antes de leer un solo dato.
 */
export const NAV_GROUPS: readonly {
  readonly label: string;
  readonly items: readonly NavItem[];
}[] = [
  {
    label: "Operación",
    items: [
      { href: "/", label: "Inicio", short: "Inicio", permissions: [], icon: "home", primary: true },
      {
        href: "/horas",
        label: "Horas",
        short: "Horas",
        permissions: [PERMISSIONS.HOURS_VIEW],
        icon: "clock",
        primary: true,
      },
      {
        href: "/staff",
        label: "Staff",
        short: "Staff",
        permissions: [PERMISSIONS.STAFF_VIEW],
        icon: "users",
        primary: true,
      },
      {
        href: "/pagos",
        label: "Pagos",
        short: "Pagos",
        permissions: [PERMISSIONS.PAYMENTS_VIEW],
        icon: "wallet",
        primary: true,
      },
      {
        href: "/periodos",
        label: "Períodos",
        short: "Períodos",
        permissions: [PERMISSIONS.WEEKS_VIEW],
        icon: "calendar",
      },
    ],
  },
  {
    label: "Análisis",
    items: [
      {
        href: "/estadisticas",
        label: "Estadísticas",
        short: "Stats",
        permissions: [PERMISSIONS.STATS_VIEW],
        icon: "chart",
      },
      {
        href: "/historial",
        label: "Historial",
        short: "Historial",
        permissions: [PERMISSIONS.HOURS_VIEW],
        icon: "history",
      },
      {
        href: "/auditoria",
        label: "Auditoría",
        short: "Auditoría",
        permissions: [PERMISSIONS.AUDIT_VIEW],
        icon: "shield",
      },
    ],
  },
  {
    label: "Sistema",
    items: [
      {
        href: "/configuracion",
        label: "Configuración",
        short: "Ajustes",
        permissions: [
          PERMISSIONS.SETTINGS_MANAGE,
          PERMISSIONS.SETTINGS_RATES,
          PERMISSIONS.USERS_VIEW,
        ],
        icon: "settings",
      },
      { href: "/perfil", label: "Mi cuenta", short: "Cuenta", permissions: [], icon: "user" },
    ],
  },
];

export function visibleItems(
  permissions: readonly string[],
  isOwner: boolean,
): readonly { readonly label: string; readonly items: readonly NavItem[] }[] {
  const granted = new Set(permissions);

  return NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter(
      (item) =>
        item.permissions.length === 0 ||
        isOwner ||
        item.permissions.some((permission) => granted.has(permission)),
    ),
  })).filter((group) => group.items.length > 0);
}
