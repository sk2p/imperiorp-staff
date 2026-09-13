import { and, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import { avisarSeguridad } from "./logbook";
import { db, type Executor } from "@/db";
import { securityEvents, type SecurityEvent } from "@/db/schema";
import { logger } from "@/lib/core/logger";
import { containsPattern, offsetFor, paginate, type Paginated } from "@/validation/common";
import type { SecurityEventType, SecurityFilters } from "@/validation/system";
/**
 * IMPERIO RP — Bitácora de seguridad.
 *
 * Separada de la auditoría de negocio a propósito: acá van los hechos sobre el
 * ACCESO al sistema (quién entró, quién falló, a quién se bloqueó), no sobre
 * los datos. Mezclarlas haría que un ataque de fuerza bruta con miles de
 * intentos sepultara el historial de horas y pagos.
 */
export type SecuritySeverity = "info" | "warning" | "critical";
const SEVERITY_BY_TYPE: Readonly<Record<SecurityEventType, SecuritySeverity>> = {
  LOGIN_SUCCESS: "info",
  LOGIN_FAILED: "warning",
  LOGIN_BLOCKED: "critical",
  LOGOUT: "info",
  SESSION_REVOKED: "warning",
  SESSION_EXPIRED: "info",
  PASSWORD_CHANGED: "warning",
  PASSWORD_RESET: "warning",
  PERMISSION_DENIED: "warning",
  ACCOUNT_LOCKED: "critical",
  ACCOUNT_DEACTIVATED: "critical",
  CSRF_REJECTED: "critical",
  SUSPICIOUS_REQUEST: "critical",
};
export const SECURITY_EVENT_LABELS: Readonly<Record<SecurityEventType, string>> = {
  LOGIN_SUCCESS: "Acceso correcto",
  LOGIN_FAILED: "Acceso fallido",
  LOGIN_BLOCKED: "Acceso bloqueado",
  LOGOUT: "Cierre de sesión",
  SESSION_REVOKED: "Sesión revocada",
  SESSION_EXPIRED: "Sesión expirada",
  PASSWORD_CHANGED: "Contraseña cambiada",
  PASSWORD_RESET: "Contraseña restablecida",
  PERMISSION_DENIED: "Permiso denegado",
  ACCOUNT_LOCKED: "Cuenta bloqueada",
  ACCOUNT_DEACTIVATED: "Cuenta desactivada",
  CSRF_REJECTED: "Petición rechazada por origen",
  SUSPICIOUS_REQUEST: "Petición sospechosa",
};
export interface SecurityEventInput {
  readonly type: SecurityEventType;
  readonly userId?: string | null;
  readonly username?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly details?: Record<string, unknown>;
}
/**
 * Registra un evento. Nunca lanza: si la bitácora falla, el flujo de acceso
 * tiene que seguir funcionando — que no se pueda escribir un log no es razón
 * para dejar a todo el staff afuera del panel.
 */
export async function recordSecurityEvent(
  input: SecurityEventInput,
  executor: Executor = db,
): Promise<void> {
  try {
    await executor.insert(securityEvents).values({
      eventType: input.type,
      severity: SEVERITY_BY_TYPE[input.type],
      userId: input.userId ?? null,
      username: input.username?.slice(0, 32) ?? null,
      ip: input.ip?.slice(0, 45) ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      details: input.details ?? null,
    });
  } catch (error) {
    logger.error("No se pudo registrar el evento de seguridad", { error, type: input.type });
  }

  /**
   * Y se avisa a Discord, fuera del `try` de la base.
   *
   * Van por caminos separados a propósito: que no se pueda escribir en la base
   * no es motivo para quedarse además sin el aviso, que es justo cuando más
   * falta hace. Tampoco espera — encola el envío y vuelve.
   */
  avisarSeguridad({
    tipo: input.type,
    etiqueta: SECURITY_EVENT_LABELS[input.type],
    severidad: SEVERITY_BY_TYPE[input.type],
    usuario: input.username ?? null,
    ip: input.ip ?? null,
    detalle: input.details ? JSON.stringify(input.details).slice(0, 400) : null,
  });
}
export async function listSecurityEvents(
  filters: SecurityFilters,
): Promise<Paginated<SecurityEvent>> {
  const conditions: SQL[] = [];
  if (filters.eventType) conditions.push(eq(securityEvents.eventType, filters.eventType));
  if (filters.severity) conditions.push(eq(securityEvents.severity, filters.severity));
  if (filters.from) {
    conditions.push(gte(securityEvents.createdAt, new Date(filters.from + "T00:00:00Z")));
  }
  if (filters.to) {
    conditions.push(lte(securityEvents.createdAt, new Date(filters.to + "T23:59:59.999Z")));
  }
  if (filters.search) {
    const pattern = containsPattern(filters.search);
    const matches = or(
      sql`${securityEvents.username} ilike ${pattern}`,
      sql`${securityEvents.ip} ilike ${pattern}`,
    );
    if (matches) conditions.push(matches);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, [countRow]] = await Promise.all([
    db
      .select()
      .from(securityEvents)
      .where(where)
      .orderBy(desc(securityEvents.createdAt))
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(where),
  ]);
  return paginate(items, countRow?.value ?? 0, filters);
}
export interface SecuritySummary {
  readonly failedLast24h: number;
  readonly successfulLast24h: number;
  readonly criticalLast7d: number;
  readonly distinctIpsLast24h: number;
}
export async function getSecuritySummary(): Promise<SecuritySummary> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      failedLast24h: sql<number>`count(*) filter (where ${securityEvents.eventType} = 'LOGIN_FAILED' and ${securityEvents.createdAt} >= ${oneDayAgo})::int`,
      successfulLast24h: sql<number>`count(*) filter (where ${securityEvents.eventType} = 'LOGIN_SUCCESS' and ${securityEvents.createdAt} >= ${oneDayAgo})::int`,
      criticalLast7d: sql<number>`count(*) filter (where ${securityEvents.severity} = 'critical' and ${securityEvents.createdAt} >= ${sevenDaysAgo})::int`,
      distinctIpsLast24h: sql<number>`count(distinct ${securityEvents.ip}) filter (where ${securityEvents.createdAt} >= ${oneDayAgo})::int`,
    })
    .from(securityEvents);
  return {
    failedLast24h: row?.failedLast24h ?? 0,
    successfulLast24h: row?.successfulLast24h ?? 0,
    criticalLast7d: row?.criticalLast7d ?? 0,
    distinctIpsLast24h: row?.distinctIpsLast24h ?? 0,
  };
}
