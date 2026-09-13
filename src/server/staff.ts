import { and, asc, desc, eq, isNull, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { db, withTransaction, type Transaction } from "@/db";
import {
  hourEntries,
  rankRates,
  staffMembers,
  staffRankHistory,
  type StaffMember,
} from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import { businessRule, concurrency, conflict, notFound, validation } from "@/lib/core/errors";
import {
  DEFAULT_RANK_COLORS,
  GROUP_LIST,
  groupForCategory,
  type StaffGroup,
} from "@/domain/groups";
import { calculateEarnings } from "@/domain/payroll";
import {
  categoryForRank,
  compareRankChange,
  rankBaseOrder,
  rankLabel,
  type StaffRank,
} from "@/domain/ranks";
import { containsPattern, offsetFor, paginate, type Paginated } from "@/validation/common";
import type {
  ArchiveStaffInput,
  ChangeRankInput,
  CreateStaffInput,
  StaffFilters,
  UpdateStaffInput,
} from "@/validation/staff";
import { appendAuditLog } from "./audit";
import { joinStaffToOpenWeek } from "./grid";
/**
 * IMPERIO RP — Miembros del staff.
 *
 * Un miembro nunca se borra. Se archiva, y su historial de horas, pagos y
 * rangos queda intacto: si Martin se va en octubre, la liquidación de
 * septiembre tiene que seguir siendo consultable y explicable en 2030.
 */
export interface StaffListItem {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly category: string;
  readonly active: boolean;
  readonly archivedAt: Date | null;
  readonly inGameId: string | null;
  readonly discordTag: string | null;
  readonly notes: string | null;
  readonly joinedAt: string | null;
  readonly version: number;
  readonly createdAt: Date;
  /** Minutos cargados en el período indicado al consultar. */
  readonly periodMinutes: number;
  readonly periodEntries: number;
}
/* -------------------------------------------------------------------------- */
/* Consultas                                                                  */
/* -------------------------------------------------------------------------- */
function staffConditions(filters: StaffFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.status === "active") conditions.push(isNull(staffMembers.archivedAt));
  if (filters.status === "archived") conditions.push(isNotNull(staffMembers.archivedAt));
  if (filters.rank) conditions.push(eq(staffMembers.rank, filters.rank));
  if (filters.category) conditions.push(eq(staffMembers.category, filters.category));
  if (filters.search) {
    const pattern = containsPattern(filters.search);
    const matches = or(
      sql`${staffMembers.name} ilike ${pattern}`,
      sql`${staffMembers.inGameId} ilike ${pattern}`,
      sql`${staffMembers.discordTag} ilike ${pattern}`,
    );
    if (matches) conditions.push(matches);
  }
  return conditions;
}
/**
 * Lista de miembros con los minutos del período pedido.
 *
 * La suma se resuelve con una subconsulta lateral en la misma ida a la base.
 * Traer los miembros y después consultar las horas de cada uno sería el clásico
 * problema N+1: con 200 miembros serían 201 consultas por cada carga de pantalla.
 */
/**
 * Las columnas de estas subconsultas van escritas a mano y calificadas.
 *
 * Interpolarlas dejaba la consulta dependiendo de un detalle invisible: el ORM
 * califica las columnas sólo cuando hay más de una tabla en juego, así que
 * `${staffMembers.id}` adentro de una subconsulta sobre `hour_entries` salía
 * bien únicamente porque esta consulta tiene un `join`. El día que alguien
 * saque el join —o copie el bloque a otra consulta que no lo tenga— el nombre
 * suelto pasa a resolverse contra la tabla de adentro, la comparación deja de
 * encontrar nada, y todas las horas dan cero sin un solo error.
 *
 * Escrito así, dice contra qué tabla se resuelve cada nombre y deja de
 * depender de la forma de la consulta que lo rodea.
 */
export async function listStaff(
  filters: StaffFilters,
  weekId?: string,
): Promise<Paginated<StaffListItem>> {
  const conditions = staffConditions(filters);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const minutesExpression = weekId
    ? sql<number>`coalesce((
        select sum(he.minutes)::int
        from hour_entries he
        where he.staff_member_id = "staff_members"."id"
          and he.week_id = ${weekId}
          and he.voided_at is null
      ), 0)`
    : sql<number>`0`;
  const entriesExpression = weekId
    ? sql<number>`coalesce((
        select count(*)::int
        from hour_entries he
        where he.staff_member_id = "staff_members"."id"
          and he.week_id = ${weekId}
          and he.voided_at is null
      ), 0)`
    : sql<number>`0`;
  const orderBy = (() => {
    const direction = filters.sortDir === "asc" ? asc : desc;
    switch (filters.sortBy) {
      case "rank":
        return [direction(staffMembers.rank), asc(staffMembers.name)];
      case "createdAt":
        return [direction(staffMembers.createdAt)];
      case "minutes":
        return [
          filters.sortDir === "asc"
            ? sql`${minutesExpression} asc`
            : sql`${minutesExpression} desc`,
          asc(staffMembers.name),
        ];
      default:
        return [filters.sortDir === "asc" ? asc(staffMembers.name) : desc(staffMembers.name)];
    }
  })();
  const [items, [countRow]] = await Promise.all([
    db
      .select({
        id: staffMembers.id,
        name: staffMembers.name,
        rank: staffMembers.rank,
        category: staffMembers.category,
        active: staffMembers.active,
        archivedAt: staffMembers.archivedAt,
        inGameId: staffMembers.inGameId,
        discordTag: staffMembers.discordTag,
        notes: staffMembers.notes,
        joinedAt: staffMembers.joinedAt,
        version: staffMembers.version,
        createdAt: staffMembers.createdAt,
        periodMinutes: minutesExpression,
        periodEntries: entriesExpression,
      })
      .from(staffMembers)
      .where(where)
      .orderBy(...orderBy)
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(staffMembers)
      .where(where),
  ]);
  return paginate(items, countRow?.value ?? 0, filters);
}
/** Selector liviano para combos y formularios. Sólo miembros activos. */
export async function listActiveStaffOptions(): Promise<
  { id: string; name: string; rank: string; category: string }[]
> {
  return db
    .select({
      id: staffMembers.id,
      name: staffMembers.name,
      rank: staffMembers.rank,
      category: staffMembers.category,
    })
    .from(staffMembers)
    .where(and(eq(staffMembers.active, true), isNull(staffMembers.archivedAt)))
    .orderBy(asc(staffMembers.name));
}
export async function getStaffMember(id: string): Promise<StaffMember | null> {
  const [member] = await db.select().from(staffMembers).where(eq(staffMembers.id, id)).limit(1);
  return member ?? null;
}
export async function requireStaffMember(id: string): Promise<StaffMember> {
  const member = await getStaffMember(id);
  if (!member) throw notFound("El miembro del staff");
  return member;
}
export async function getStaffRankHistory(staffMemberId: string) {
  return db
    .select()
    .from(staffRankHistory)
    .where(eq(staffRankHistory.staffMemberId, staffMemberId))
    .orderBy(desc(staffRankHistory.createdAt))
    .limit(50);
}
export async function countStaff(): Promise<{ active: number; archived: number }> {
  const [row] = await db
    .select({
      active: sql<number>`count(*) filter (where ${staffMembers.archivedAt} is null)::int`,
      archived: sql<number>`count(*) filter (where ${staffMembers.archivedAt} is not null)::int`,
    })
    .from(staffMembers);
  return { active: row?.active ?? 0, archived: row?.archived ?? 0 };
}
/* -------------------------------------------------------------------------- */
/* Escrituras                                                                 */
/* -------------------------------------------------------------------------- */
/** Vista reducida para la auditoría: sin ruido de campos técnicos. */
function auditView(member: StaffMember) {
  return {
    nombre: member.name,
    rango: member.rank,
    categoria: member.category,
    idEnServidor: member.inGameId,
    discord: member.discordTag,
    ingreso: member.joinedAt,
    notas: member.notes,
    activo: member.active,
  };
}
export async function createStaffMember(
  input: CreateStaffInput,
  actor: ActorContext,
): Promise<StaffMember> {
  const category = categoryForRank(input.rank);
  return withTransaction(async (tx) => {
    // El índice único de la base es la garantía real; esta consulta existe para
    // poder dar un mensaje claro en vez de un error de restricción.
    const [duplicate] = await tx
      .select({ id: staffMembers.id, name: staffMembers.name })
      .from(staffMembers)
      .where(
        and(
          sql`lower(${staffMembers.name}) = ${input.name.toLowerCase()}`,
          isNull(staffMembers.archivedAt),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw conflict(
        'Ya hay un miembro activo llamado "' +
          duplicate.name +
          '". Usá un nombre distinto o reincorporá al existente.',
      );
    }
    const [created] = await tx
      .insert(staffMembers)
      .values({
        name: input.name,
        rank: input.rank,
        category,
        // Entra en el escalón de su rango, no al principio de la lista.
        displayOrder: rankBaseOrder(input.rank),
        createdBy: actor.id,
      })
      .returning();
    if (!created) throw new Error("No se pudo crear el miembro del staff.");
    await tx.insert(staffRankHistory).values({
      staffMemberId: created.id,
      fromRank: null,
      toRank: input.rank,
      changeType: "alta",
      reason: "Alta inicial en el staff",
      changedBy: actor.id,
      changedByUsername: actor.username,
    });
    /**
     * El alta entra al período EN CURSO, no al siguiente: si alguien se suma un
     * jueves tiene que poder cargar las horas de ese mismo jueves. Los días
     * anteriores quedan marcados como "todavía no estaba".
     */
    const joined = await joinStaffToOpenWeek(tx, created.id, new Date().toISOString().slice(0, 10));

    await appendAuditLog(tx, {
      actor,
      action: "STAFF_CREATED",
      entity: "staff_members",
      entityId: created.id,
      summary: "Dio de alta a " + created.name + " como " + rankLabel(created.rank),
      after: auditView(created),
      metadata: joined
        ? { periodo: joined.weekId, diasMarcadosComoPrevios: joined.markedDays }
        : { periodo: "ninguno abierto" },
    });
    return created;
  });
}
/**
 * Actualiza los datos generales. El rango se cambia con `changeStaffRank`,
 * que exige permiso y motivo aparte.
 */
export async function updateStaffMember(
  input: UpdateStaffInput,
  actor: ActorContext,
): Promise<StaffMember> {
  return withTransaction(async (tx) => {
    const existing = await lockStaffMember(tx, input.id);
    if (existing.archivedAt) {
      throw businessRule("El miembro está archivado. Reincorporalo antes de editar sus datos.");
    }
    if (existing.name.toLowerCase() !== input.name.toLowerCase()) {
      const [duplicate] = await tx
        .select({ id: staffMembers.id })
        .from(staffMembers)
        .where(
          and(
            sql`lower(${staffMembers.name}) = ${input.name.toLowerCase()}`,
            isNull(staffMembers.archivedAt),
            sql`${staffMembers.id} <> ${input.id}`,
          ),
        )
        .limit(1);
      if (duplicate) {
        throw conflict('Ya hay otro miembro activo llamado "' + input.name + '".');
      }
    }
    const [updated] = await tx
      .update(staffMembers)
      .set({
        name: input.name,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(staffMembers.id, input.id), eq(staffMembers.version, input.expectedVersion)))
      .returning();
    if (!updated) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "STAFF_UPDATED",
      entity: "staff_members",
      entityId: updated.id,
      summary: "Editó los datos de " + updated.name,
      before: auditView(existing),
      after: auditView(updated),
    });
    return updated;
  });
}
/**
 * Cambia el rango.
 *
 * La tarifa nueva rige de aquí en adelante. Los períodos ya cerrados conservan
 * su snapshot: el ascenso de Martin a ADM no reescribe lo que cobró como MOD.
 */
export async function changeStaffRank(
  input: ChangeRankInput,
  actor: ActorContext,
): Promise<StaffMember> {
  return withTransaction(async (tx) => {
    const existing = await lockStaffMember(tx, input.id);
    if (existing.rank === input.rank) {
      throw validation("El miembro ya tiene ese rango.", { rank: ["Elegí un rango distinto."] });
    }
    if (existing.archivedAt) {
      throw businessRule("No se puede cambiar el rango de un miembro archivado.");
    }
    const changeType = compareRankChange(existing.rank, input.rank);
    const [updated] = await tx
      .update(staffMembers)
      .set({
        rank: input.rank,
        category: categoryForRank(input.rank as StaffRank),
        // Se reubica en el escalón del rango nuevo, igual que desde la grilla.
        displayOrder: rankBaseOrder(input.rank),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(staffMembers.id, input.id), eq(staffMembers.version, input.expectedVersion)))
      .returning();
    if (!updated) throw concurrency();
    await tx.insert(staffRankHistory).values({
      staffMemberId: updated.id,
      fromRank: existing.rank,
      toRank: input.rank,
      changeType,
      reason: input.reason,
      changedBy: actor.id,
      changedByUsername: actor.username,
    });
    await appendAuditLog(tx, {
      actor,
      action: "STAFF_RANK_CHANGED",
      entity: "staff_members",
      entityId: updated.id,
      summary: "Cambió el rango de " + updated.name + ": " + existing.rank + " → " + input.rank,
      before: { rango: existing.rank, categoria: existing.category },
      after: { rango: updated.rank, categoria: updated.category },
      reason: input.reason,
      metadata: { tipoDeCambio: changeType },
    });
    return updated;
  });
}
export async function archiveStaffMember(
  input: ArchiveStaffInput,
  actor: ActorContext,
): Promise<StaffMember> {
  return withTransaction(async (tx) => {
    const existing = await lockStaffMember(tx, input.id);
    if (existing.archivedAt) {
      throw businessRule("El miembro ya está archivado.");
    }
    // Confirmación por nombre: obliga a leer a quién se está archivando.
    if (input.confirmName.trim().toLowerCase() !== existing.name.toLowerCase()) {
      throw validation("El nombre no coincide.", {
        confirmName: ['Escribí exactamente "' + existing.name + '" para confirmar.'],
      });
    }
    const now = new Date();
    const [archived] = await tx
      .update(staffMembers)
      .set({
        active: false,
        archivedAt: now,
        archivedBy: actor.id,
        archiveReason: input.reason,
        version: existing.version + 1,
        updatedAt: now,
      })
      .where(and(eq(staffMembers.id, input.id), eq(staffMembers.version, input.expectedVersion)))
      .returning();
    if (!archived) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "STAFF_ARCHIVED",
      entity: "staff_members",
      entityId: archived.id,
      summary: "Archivó a " + archived.name + " (" + archived.rank + ")",
      before: auditView(existing),
      after: auditView(archived),
      reason: input.reason,
    });
    return archived;
  });
}
export async function restoreStaffMember(
  id: string,
  reason: string,
  actor: ActorContext,
): Promise<StaffMember> {
  return withTransaction(async (tx) => {
    const existing = await lockStaffMember(tx, id);
    if (!existing.archivedAt) {
      throw businessRule("El miembro no está archivado.");
    }
    const [duplicate] = await tx
      .select({ id: staffMembers.id })
      .from(staffMembers)
      .where(
        and(
          sql`lower(${staffMembers.name}) = ${existing.name.toLowerCase()}`,
          isNull(staffMembers.archivedAt),
        ),
      )
      .limit(1);
    if (duplicate) {
      throw conflict(
        'Ya hay un miembro activo llamado "' +
          existing.name +
          '". Renombrá a uno de los dos antes de reincorporarlo.',
      );
    }
    const [restored] = await tx
      .update(staffMembers)
      .set({
        active: true,
        archivedAt: null,
        archivedBy: null,
        archiveReason: null,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(staffMembers.id, id))
      .returning();
    if (!restored) throw concurrency();
    await appendAuditLog(tx, {
      actor,
      action: "STAFF_RESTORED",
      entity: "staff_members",
      entityId: restored.id,
      summary: "Reincorporó a " + restored.name,
      before: auditView(existing),
      after: auditView(restored),
      reason,
    });
    return restored;
  });
}
/**
 * Lee la fila bloqueándola hasta el fin de la transacción.
 *
 * Sin esto, dos ediciones simultáneas podrían leer la misma versión, y una
 * pisaría a la otra sin que nadie se entere. `FOR UPDATE` hace que la segunda
 * espere y encuentre la versión ya incrementada, que es justo lo que dispara el
 * error de concurrencia que el usuario necesita ver.
 */
async function lockStaffMember(tx: Transaction, id: string): Promise<StaffMember> {
  const [member] = await tx
    .select()
    .from(staffMembers)
    .where(eq(staffMembers.id, id))
    .limit(1)
    .for("update");
  if (!member) throw notFound("El miembro del staff");
  return member;
}

/* -------------------------------------------------------------------------- */
/* Tablero del staff                                                          */
/* -------------------------------------------------------------------------- */

/**
 * El staff completo, en el mismo orden que la planilla de horas.
 *
 * Sin paginado: el equipo son cuarenta personas, no cuatro mil, y partirlo en
 * páginas obligaba a saltar de una a otra para ver el plantel entero. Se trae
 * todo de una y se lee de arriba a abajo, agrupado en High, Mid y Low y
 * ordenado por la misma posición que se acomoda arrastrando en /horas, para
 * que las dos pantallas no digan cosas distintas sobre la jerarquía.
 */
export interface StaffBoardCard {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly rankColor: string;
  readonly category: string;
  readonly hourlyRate: number;
  readonly inGameId: string | null;
  readonly discordTag: string | null;
  readonly joinedAt: string | null;
  readonly notes: string | null;
  readonly archivedAt: Date | null;
  readonly version: number;
  readonly periodMinutes: number;
  readonly periodEntries: number;
  readonly periodAmount: number;
}

export interface StaffBoardGroup {
  readonly group: StaffGroup;
  readonly cards: readonly StaffBoardCard[];
  readonly totalMinutes: number;
  readonly totalAmount: number;
}

export interface StaffBoard {
  readonly groups: readonly StaffBoardGroup[];
  readonly memberCount: number;
  readonly totalMinutes: number;
  readonly totalAmount: number;
}

export async function getStaffBoard(
  weekId: string | undefined,
  includeArchived: boolean,
): Promise<StaffBoard> {
  const minutes = weekId
    ? sql<number>`coalesce((
        select sum(he.minutes)::int
        from hour_entries he
        where he.staff_member_id = "staff_members"."id"
          and he.week_id = ${weekId}
          and he.status = 'normal'
          and he.voided_at is null
      ), 0)`
    : sql<number>`0`;

  const entries = weekId
    ? sql<number>`coalesce((
        select count(*)::int
        from hour_entries he
        where he.staff_member_id = "staff_members"."id"
          and he.week_id = ${weekId}
          and he.voided_at is null
      ), 0)`
    : sql<number>`0`;

  const rows = await db
    .select({
      id: staffMembers.id,
      name: staffMembers.name,
      rank: staffMembers.rank,
      rankColor: rankRates.color,
      hourlyRate: rankRates.ratePerHour,
      category: staffMembers.category,
      inGameId: staffMembers.inGameId,
      discordTag: staffMembers.discordTag,
      joinedAt: staffMembers.joinedAt,
      notes: staffMembers.notes,
      archivedAt: staffMembers.archivedAt,
      displayOrder: staffMembers.displayOrder,
      version: staffMembers.version,
      periodMinutes: minutes,
      periodEntries: entries,
    })
    .from(staffMembers)
    .leftJoin(rankRates, eq(rankRates.rank, staffMembers.rank))
    .where(includeArchived ? undefined : isNull(staffMembers.archivedAt))
    .orderBy(asc(staffMembers.displayOrder), asc(staffMembers.name));

  const cards: (StaffBoardCard & { group: StaffGroup })[] = rows.map((row) => {
    const hourlyRate = row.hourlyRate ?? 0;
    return {
      id: row.id,
      name: row.name,
      rank: row.rank,
      rankColor: row.rankColor ?? DEFAULT_RANK_COLORS[row.rank] ?? "#6f747d",
      category: row.category,
      hourlyRate,
      inGameId: row.inGameId,
      discordTag: row.discordTag,
      joinedAt: row.joinedAt,
      notes: row.notes,
      archivedAt: row.archivedAt,
      version: row.version,
      periodMinutes: row.periodMinutes,
      periodEntries: row.periodEntries,
      periodAmount: calculateEarnings(row.periodMinutes, hourlyRate),
      group: groupForCategory(row.category),
    };
  });

  const groups: StaffBoardGroup[] = [];
  for (const group of GROUP_LIST) {
    const miembros = cards.filter((card) => card.group === group.group);
    if (miembros.length === 0) continue;

    groups.push({
      group: group.group,
      cards: miembros,
      totalMinutes: miembros.reduce((sum, card) => sum + card.periodMinutes, 0),
      totalAmount: miembros.reduce((sum, card) => sum + card.periodAmount, 0),
    });
  }

  return {
    groups,
    memberCount: cards.length,
    totalMinutes: groups.reduce((sum, group) => sum + group.totalMinutes, 0),
    totalAmount: groups.reduce((sum, group) => sum + group.totalAmount, 0),
  };
}
