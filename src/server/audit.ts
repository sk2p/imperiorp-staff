import { and, asc, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import crypto from "node:crypto";
import { db, withTransaction, type Transaction } from "@/db";
import { auditLogs, users, type AuditLog } from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import { logger } from "@/lib/core/logger";
import { anotarEnBitacora } from "./logbook";
import { containsPattern, offsetFor, paginate, type Paginated } from "@/validation/common";
import type { AuditAction, AuditFilters } from "@/validation/system";
/**
 * IMPERIO RP — Auditoría a prueba de manipulación.
 *
 * Cada registro incorpora el hash del anterior, formando una cadena. Alterar el
 * contenido de una fila, borrar una del medio o reordenarlas rompe la cadena, y
 * `verifyAuditChain()` señala exactamente dónde.
 *
 * Esto no vuelve imposible la manipulación — quien tenga acceso total a
 * PostgreSQL puede reescribir la cadena entera —, pero sí la vuelve DETECTABLE,
 * que es lo que se le puede pedir a un registro de auditoría dentro de la propia
 * aplicación. La defensa completa se cierra con las copias de seguridad
 * externas descritas en el README.
 */
/** Identificador del bloqueo consultivo que serializa el avance de la cadena. */
const CHAIN_LOCK_ID = 918_273_645;
/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */
/**
 * Serialización canónica: las claves de todo objeto se ordenan, de modo que dos
 * estructuras equivalentes produzcan siempre exactamente el mismo texto y, por
 * lo tanto, el mismo hash.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => JSON.stringify(key) + ":" + stableStringify(nested));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value);
}
interface HashableEntry {
  readonly actorUsername: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly summary: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly hashPrev: string | null;
}
function computeHash(entry: HashableEntry): string {
  return crypto.createHash("sha256").update(stableStringify(entry)).digest("hex");
}
/* -------------------------------------------------------------------------- */
/* Escritura                                                                  */
/* -------------------------------------------------------------------------- */
export interface AuditEntryInput {
  readonly actor: ActorContext;
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId: string;
  /** Frase legible: "Modificó las horas de Martin". */
  readonly summary: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown>;
}
/** Campos que cambiaron entre dos estados. Ahorra comparar dos JSON a ojo. */
function diffFields(before: unknown, after: unknown): string[] | null {
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null
  ) {
    return null;
  }
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
  const changed = [...keys].filter(
    (key) => stableStringify(beforeRecord[key]) !== stableStringify(afterRecord[key]),
  );
  return changed.length > 0 ? changed : null;
}
/**
 * Agrega un registro a la cadena. DEBE ejecutarse dentro de una transacción:
 * el bloqueo consultivo que impide dos escrituras simultáneas vive mientras
 * dure esa transacción.
 *
 * Al compartir transacción con la operación auditada se obtiene la garantía
 * más importante del sistema: no existe forma de que un cambio se aplique sin
 * su registro de auditoría, ni de que quede un registro de algo que no ocurrió.
 */
export async function appendAuditLog(tx: Transaction, input: AuditEntryInput): Promise<AuditLog> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CHAIN_LOCK_ID})`);
  const [previous] = await tx
    .select({ hash: auditLogs.hash })
    .from(auditLogs)
    .orderBy(desc(auditLogs.sequence))
    .limit(1);
  const hashPrev = previous?.hash ?? null;
  const createdAt = new Date();
  const before = input.before ?? null;
  const after = input.after ?? null;
  const reason = input.reason ?? null;
  const hash = computeHash({
    actorUsername: input.actor.username,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    summary: input.summary,
    before,
    after,
    reason,
    createdAt: createdAt.toISOString(),
    hashPrev,
  });
  const [inserted] = await tx
    .insert(auditLogs)
    .values({
      actorId: input.actor.id,
      actorUsername: input.actor.username,
      actorRole: input.actor.role,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      summary: input.summary.slice(0, 240),
      before,
      after,
      changedFields: diffFields(before, after),
      reason,
      metadata: input.metadata ?? null,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      traceId: input.actor.traceId,
      hashPrev,
      hash,
      createdAt,
    })
    .returning();
  if (!inserted) {
    throw new Error("No se pudo registrar la entrada de auditoría.");
  }

  /**
   * Se anota para la bitácora de Discord.
   *
   * Encola y vuelve: no espera a Discord ni lo deja frenar la transacción. La
   * tanda comprueba después, contra la base, que la entrada haya quedado — esta
   * transacción todavía puede revertirse y no se puede anunciar algo que al
   * final no pasó.
   */
  anotarEnBitacora({
    id: inserted.id,
    accion: input.action,
    actor: input.actor.username,
    resumen: input.summary,
    motivo: reason,
  });

  return inserted;
}
/**
 * Variante para operaciones que no forman parte de una transacción mayor
 * (por ejemplo, registrar una exportación). Abre su propia transacción.
 */
export async function logAudit(input: AuditEntryInput): Promise<void> {
  try {
    await withTransaction((tx) => appendAuditLog(tx, input));
  } catch (error) {
    // Un fallo al auditar no debe tumbar la operación del usuario, pero sí
    // tiene que quedar registrado a gritos en los logs del servidor.
    logger.error("No se pudo escribir en la auditoría", {
      error,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
    });
  }
}
/* -------------------------------------------------------------------------- */
/* Lectura                                                                    */
/* -------------------------------------------------------------------------- */
export interface AuditLogView {
  readonly id: string;
  readonly sequence: number;
  readonly actorUsername: string;
  readonly actorRole: string | null;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string;
  readonly summary: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly changedFields: readonly string[] | null;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly createdAt: Date;
}
function auditConditions(filters: AuditFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
  if (filters.entity) conditions.push(eq(auditLogs.entity, filters.entity));
  if (filters.entityId) conditions.push(eq(auditLogs.entityId, filters.entityId));
  if (filters.actorId) conditions.push(eq(auditLogs.actorId, filters.actorId));
  if (filters.from)
    conditions.push(gte(auditLogs.createdAt, new Date(filters.from + "T00:00:00Z")));
  if (filters.to)
    conditions.push(lte(auditLogs.createdAt, new Date(filters.to + "T23:59:59.999Z")));
  if (filters.search) {
    const pattern = containsPattern(filters.search);
    const matches = or(
      sql`${auditLogs.summary} ilike ${pattern}`,
      sql`${auditLogs.actorUsername} ilike ${pattern}`,
      sql`${auditLogs.reason} ilike ${pattern}`,
    );
    if (matches) conditions.push(matches);
  }
  return conditions;
}
export async function listAuditLogs(filters: AuditFilters): Promise<Paginated<AuditLogView>> {
  const conditions = auditConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const direction = filters.sortDir === "asc" ? asc : desc;
  const [rows, [countRow]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        sequence: auditLogs.sequence,
        actorUsername: auditLogs.actorUsername,
        actorRole: auditLogs.actorRole,
        action: auditLogs.action,
        entity: auditLogs.entity,
        entityId: auditLogs.entityId,
        summary: auditLogs.summary,
        before: auditLogs.before,
        after: auditLogs.after,
        changedFields: auditLogs.changedFields,
        reason: auditLogs.reason,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(where)
      .orderBy(direction(auditLogs.sequence))
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where),
  ]);
  return paginate(rows, countRow?.value ?? 0, filters);
}
/** Historial completo de una entidad concreta, del más nuevo al más viejo. */
export async function getEntityHistory(
  entity: string,
  entityId: string,
  limit = 50,
): Promise<AuditLogView[]> {
  return db
    .select({
      id: auditLogs.id,
      sequence: auditLogs.sequence,
      actorUsername: auditLogs.actorUsername,
      actorRole: auditLogs.actorRole,
      action: auditLogs.action,
      entity: auditLogs.entity,
      entityId: auditLogs.entityId,
      summary: auditLogs.summary,
      before: auditLogs.before,
      after: auditLogs.after,
      changedFields: auditLogs.changedFields,
      reason: auditLogs.reason,
      ip: auditLogs.ip,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.entity, entity), eq(auditLogs.entityId, entityId)))
    .orderBy(desc(auditLogs.sequence))
    .limit(limit);
}
/** Usuarios que aparecen como actores. Alimenta el filtro de la pantalla. */
export async function listAuditActors(): Promise<{ id: string; username: string }[]> {
  return db
    .selectDistinct({ id: users.id, username: users.username })
    .from(auditLogs)
    .innerJoin(users, eq(auditLogs.actorId, users.id))
    .orderBy(asc(users.username));
}
/* -------------------------------------------------------------------------- */
/* Verificación de integridad                                                 */
/* -------------------------------------------------------------------------- */
export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  /** Secuencia del primer registro cuyo hash no cuadra. */
  readonly brokenAtSequence?: number;
  readonly message: string;
}
/**
 * Recalcula la cadena completa y la compara con lo almacenado.
 *
 * Se recorre por lotes para que verificar cien mil registros no cargue la tabla
 * entera en memoria.
 */
export async function verifyAuditChain(maxRecords = 100_000): Promise<ChainVerification> {
  const batchSize = 1_000;
  let checked = 0;
  let expectedPrev: string | null = null;
  let cursor = 0;
  while (checked < maxRecords) {
    const batch: AuditLog[] = await db
      .select()
      .from(auditLogs)
      .where(sql`${auditLogs.sequence} > ${cursor}`)
      .orderBy(asc(auditLogs.sequence))
      .limit(batchSize);
    if (batch.length === 0) break;
    for (const record of batch) {
      if (record.hashPrev !== expectedPrev) {
        return {
          ok: false,
          checked,
          brokenAtSequence: record.sequence,
          message:
            "La cadena se rompe en el registro #" +
            record.sequence +
            ": el enlace al anterior no coincide. Puede haberse borrado o alterado una fila.",
        };
      }
      const recomputed = computeHash({
        actorUsername: record.actorUsername,
        action: record.action,
        entity: record.entity,
        entityId: record.entityId,
        summary: record.summary,
        before: record.before ?? null,
        after: record.after ?? null,
        reason: record.reason ?? null,
        createdAt: record.createdAt.toISOString(),
        hashPrev: record.hashPrev,
      });
      if (recomputed !== record.hash) {
        return {
          ok: false,
          checked,
          brokenAtSequence: record.sequence,
          message:
            "El contenido del registro #" +
            record.sequence +
            " no coincide con su hash: fue modificado después de haberse escrito.",
        };
      }
      expectedPrev = record.hash;
      checked += 1;
      cursor = record.sequence;
    }
    if (batch.length < batchSize) break;
  }
  return {
    ok: true,
    checked,
    message:
      checked === 0
        ? "Todavía no hay registros de auditoría."
        : "Cadena íntegra: se verificaron " + checked + " registros sin alteraciones.",
  };
}
