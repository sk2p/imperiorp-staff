import { Icon } from "@/components/layout/icons";
import { localDate, localDateLong, localDateTime, localTime } from "@/domain/clock";
import { cn } from "@/components/ui/primitives";
import { AUDIT_ACTION_LABELS, type AuditAction } from "@/validation/system";

/**
 * El registro de todo lo que pasa en la página.
 *
 * Antes era una lista plana de filas técnicas: hash, número de secuencia, IP y
 * dos columnas de JSON. Servía para auditar, no para leer.
 *
 * Acá la pregunta es otra: "¿qué se hizo hoy?". Entonces se agrupa por día,
 * cada línea dice quién hizo qué en una sola frase, el color y el ícono cuentan
 * de qué se trata antes de leer, y todo lo técnico —los valores viejos y
 * nuevos, la IP, el número de orden— queda plegado detrás de "Ver detalle",
 * disponible para cuando de verdad haga falta.
 */

type Familia = "staff" | "horas" | "periodos" | "pagos" | "cuentas" | "sistema";

const FAMILIA_POR_ACCION: Readonly<Record<string, Familia>> = {
  STAFF_CREATED: "staff",
  STAFF_UPDATED: "staff",
  STAFF_RANK_CHANGED: "staff",
  STAFF_ARCHIVED: "staff",
  STAFF_RESTORED: "staff",
  HOURS_LOGGED: "horas",
  HOURS_BULK_LOGGED: "horas",
  HOURS_UPDATED: "horas",
  HOURS_VOIDED: "horas",
  WEEK_CREATED: "periodos",
  WEEK_UPDATED: "periodos",
  WEEK_CLOSED: "periodos",
  WEEK_REOPENED: "periodos",
  WEEK_MEMBER_ADDED: "periodos",
  PAYMENT_CREATED: "pagos",
  PAYMENT_BULK_CREATED: "pagos",
  PAYMENT_UPDATED: "pagos",
  PAYMENT_VOIDED: "pagos",
  USER_CREATED: "cuentas",
  USER_UPDATED: "cuentas",
  USER_PASSWORD_RESET: "cuentas",
  USER_PASSWORD_CHANGED: "cuentas",
  USER_SESSIONS_REVOKED: "cuentas",
  RATE_UPDATED: "sistema",
  SETTING_UPDATED: "sistema",
  DATA_EXPORTED: "sistema",
  DATA_IMPORTED: "sistema",
};

const FAMILIAS: Readonly<
  Record<Familia, { readonly label: string; readonly icon: string; readonly clase: string }>
> = {
  staff: { label: "Staff", icon: "users", clase: "log-staff" },
  horas: { label: "Horas", icon: "clock", clase: "log-horas" },
  periodos: { label: "Períodos", icon: "calendar", clase: "log-periodos" },
  pagos: { label: "Pagos", icon: "wallet", clase: "log-pagos" },
  cuentas: { label: "Cuentas", icon: "lock", clase: "log-cuentas" },
  sistema: { label: "Sistema", icon: "settings", clase: "log-sistema" },
};

/** Acciones que conviene que salten a la vista. */
const DELICADAS = new Set([
  "PAYMENT_VOIDED",
  "HOURS_VOIDED",
  "WEEK_REOPENED",
  "USER_PASSWORD_RESET",
  "USER_SESSIONS_REVOKED",
  "STAFF_ARCHIVED",
]);

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly summary: string;
  readonly actorUsername: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly before: unknown;
  readonly after: unknown;
  readonly changedFields: readonly string[] | null;
}

function familiaDe(action: string): Familia {
  return FAMILIA_POR_ACCION[action] ?? "sistema";
}

/** "hace 5 min", "hace 3 h". Más allá de un día ya manda la fecha del grupo. */
function haceCuanto(fecha: Date, ahora: Date): string {
  const segundos = Math.max(0, Math.round((ahora.getTime() - fecha.getTime()) / 1000));
  if (segundos < 60) return "recién";
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return "hace " + minutos + " min";
  const horas = Math.round(minutos / 60);
  if (horas < 24) return "hace " + horas + " h";
  const dias = Math.round(horas / 24);
  return "hace " + dias + (dias === 1 ? " día" : " días");
}

/**
 * Agrupar por día usa la zona horaria de la APLICACIÓN, no la del proceso.
 *
 * `toLocaleDateString` sin zona usa la del servidor, que en Vercel es UTC. Un
 * movimiento de las 21:30 de Argentina caía en el grupo del día siguiente, y
 * el registro de auditoría quedaba ordenado por un día que nadie vivió.
 */
function claveDeDia(fecha: Date): string {
  return localDate(fecha);
}

function tituloDeDia(fecha: Date, ahora: Date): string {
  const hoy = claveDeDia(ahora);
  const ayer = claveDeDia(new Date(ahora.getTime() - 86_400_000));
  const clave = claveDeDia(fecha);

  if (clave === hoy) return "Hoy";
  if (clave === ayer) return "Ayer";
  return localDateLong(fecha);
}

function valorLegible(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "sí" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** `totalMinutos` → `Total minutos`. Los nombres de campo son de la base. */
function campoLegible(key: string): string {
  const conEspacios = key.replaceAll(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
  return conEspacios.charAt(0).toUpperCase() + conEspacios.slice(1).toLowerCase();
}

function Cambios({ entry }: { readonly entry: AuditEntry }) {
  const antes = (entry.before ?? {}) as Record<string, unknown>;
  const despues = (entry.after ?? {}) as Record<string, unknown>;
  const claves =
    entry.changedFields && entry.changedFields.length > 0
      ? entry.changedFields
      : [...new Set([...Object.keys(antes), ...Object.keys(despues)])];

  if (claves.length === 0) return null;

  return (
    <div className="border-line mt-2 overflow-hidden rounded-lg border">
      <table className="w-full text-[0.6875rem]">
        <tbody>
          {claves.slice(0, 10).map((key) => (
            <tr key={key} className="border-b border-white/[0.05] last:border-0">
              <td className="text-chalk-500 w-36 bg-white/[0.02] px-2.5 py-1.5 font-semibold">
                {campoLegible(key)}
              </td>
              <td className="text-imperial-400/75 px-2.5 py-1.5 line-through">
                {valorLegible(antes[key])}
              </td>
              <td className="text-jade-400 px-2.5 py-1.5">{valorLegible(despues[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Linea({ entry, ahora }: { readonly entry: AuditEntry; readonly ahora: Date }) {
  const familia = FAMILIAS[familiaDe(entry.action)];
  const delicada = DELICADAS.has(entry.action);
  const hayDetalle = Boolean(entry.before || entry.after);

  return (
    <li className="log-row">
      <span className={cn("log-icon", familia.clase)}>
        <Icon name={familia.icon} size={14} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-chalk-100 text-sm leading-snug">
          <span className="text-chalk-50 font-semibold">{entry.actorUsername}</span>{" "}
          <span className="text-chalk-300">{entry.summary}</span>
        </p>

        <p className="text-chalk-600 mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[0.6875rem]">
          <span className={cn("log-tag", familia.clase)}>
            {AUDIT_ACTION_LABELS[entry.action as AuditAction] ?? entry.action}
          </span>
          {delicada ? <span className="log-tag log-delicada">Sensible</span> : null}
          <span title={localDateTime(entry.createdAt)}>
            {haceCuanto(entry.createdAt, ahora)}
            {" · "}
            {localTime(entry.createdAt)}
          </span>
        </p>

        {entry.reason ? (
          <p className="border-imperial-500/40 text-chalk-300 mt-1.5 rounded-md border-l-2 bg-white/[0.02] px-2.5 py-1.5 text-xs">
            {entry.reason}
          </p>
        ) : null}

        {hayDetalle ? (
          <details className="log-detalle">
            <summary>Ver detalle</summary>
            <Cambios entry={entry} />
            <p className="text-chalk-700 mt-1.5 text-[0.625rem]">
              Registro #{entry.sequence}
              {entry.ip ? " · desde " + entry.ip : ""}
            </p>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export function AuditFeed({ entries }: { readonly entries: readonly AuditEntry[] }) {
  const ahora = new Date();

  // Agrupado por día, en el orden en que vienen (del más nuevo al más viejo).
  const dias: { titulo: string; entradas: AuditEntry[] }[] = [];
  for (const entry of entries) {
    const titulo = tituloDeDia(entry.createdAt, ahora);
    const ultimo = dias.at(-1);
    if (ultimo && ultimo.titulo === titulo) ultimo.entradas.push(entry);
    else dias.push({ titulo, entradas: [entry] });
  }

  return (
    <div className="flex flex-col">
      {dias.map((dia) => (
        <section key={dia.titulo}>
          <p className="text-chalk-500 sticky top-0 z-10 border-y border-white/[0.05] bg-[var(--surface)]/95 px-4 py-1.5 text-[0.625rem] font-bold tracking-[0.14em] uppercase backdrop-blur">
            {dia.titulo}
            <span className="text-chalk-700 ml-2 font-medium normal-case">
              {dia.entradas.length} {dia.entradas.length === 1 ? "acción" : "acciones"}
            </span>
          </p>

          <ul className="stagger">
            {dia.entradas.map((entry) => (
              <Linea key={entry.id} entry={entry} ahora={ahora} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
