import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db, withTransaction, type Transaction } from "@/db";
import { hourEntries, staffMembers, weeklyStaffRecords, type Week } from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import { businessRule, concurrency, notFound, validation } from "@/lib/core/errors";
import { formatMoney } from "@/domain/money";
import {
  groupForCategory,
  isWeeklyStatus,
  statusCounts,
  statusLabel,
  WEEKLY_STATUS_DEFINITIONS,
  type StaffGroup,
  type WeeklyStatus,
} from "@/domain/groups";
import { eachDayOfPeriod, formatCalendarDate, isDateWithinPeriod } from "@/domain/periods";
import { formatMinutes, MAX_MINUTES_PER_ENTRY } from "@/domain/time";
import { appendAuditLog } from "./audit";
import { loadWeekForWrite, recalculateWeekRecords } from "./weeks";

/**
 * IMPERIO RP — Grilla semanal de horas.
 *
 * El equipo carga las horas como una planilla: una fila por persona, una
 * casilla por día. Cada casilla ES una entrada de `hour_entries`, así que se
 * conserva todo lo de antes —quién la cargó, cuándo, el historial completo— sin
 * que haya que describir un turno para anotar dos horas de un martes.
 */

export interface GridCell {
  readonly workDate: string;
  readonly minutes: number;
  readonly entryId: string | null;
  readonly recordedByUsername: string | null;
  readonly note: string | null;
}

export interface GridRow {
  readonly staffMemberId: string;
  readonly recordId: string | null;
  readonly name: string;
  readonly rank: string;
  readonly category: string;
  readonly group: StaffGroup;
  readonly hourlyRate: number;
  readonly displayOrder: number;
  readonly version: number;
  readonly status: WeeklyStatus;
  readonly statusNote: string | null;
  readonly days: readonly GridCell[];
  readonly totalMinutes: number;
  readonly amount: number;
}

export interface GridGroup {
  readonly group: StaffGroup;
  readonly hourlyRate: number;
  readonly memberCount: number;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly rows: readonly GridRow[];
}

export interface WeekGrid {
  readonly weekId: string;
  readonly days: readonly string[];
  readonly groups: readonly GridGroup[];
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly memberCount: number;
  readonly editable: boolean;
}

/* -------------------------------------------------------------------------- */
/* Lectura                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Arma la planilla completa del período en dos consultas, sin importar cuántas
 * personas haya: una trae las filas y otra todas las casillas. Consultar los
 * días de cada persona por separado sería una consulta por fila.
 */
export async function getWeekGrid(week: Week): Promise<WeekGrid> {
  const days = eachDayOfPeriod(week.startDate, week.endDate);

  const [records, cells] = await Promise.all([
    db
      .select({
        staffMemberId: weeklyStaffRecords.staffMemberId,
        recordId: weeklyStaffRecords.id,
        name: weeklyStaffRecords.staffNameSnapshot,
        rank: weeklyStaffRecords.rankSnapshot,
        category: weeklyStaffRecords.categorySnapshot,
        hourlyRate: weeklyStaffRecords.hourlyRateSnapshot,
        totalMinutes: weeklyStaffRecords.totalMinutes,
        amount: weeklyStaffRecords.calculatedAmount,
        status: weeklyStaffRecords.status,
        statusNote: weeklyStaffRecords.statusNote,
        version: weeklyStaffRecords.version,
        displayOrder: staffMembers.displayOrder,
      })
      .from(weeklyStaffRecords)
      .innerJoin(staffMembers, eq(weeklyStaffRecords.staffMemberId, staffMembers.id))
      .where(eq(weeklyStaffRecords.weekId, week.id))
      .orderBy(asc(staffMembers.displayOrder), asc(weeklyStaffRecords.staffNameSnapshot)),

    db
      .select({
        staffMemberId: hourEntries.staffMemberId,
        workDate: hourEntries.workDate,
        minutes: hourEntries.minutes,
        entryId: hourEntries.id,
        recordedByUsername: hourEntries.recordedByUsername,
        note: hourEntries.reason,
      })
      .from(hourEntries)
      .where(and(eq(hourEntries.weekId, week.id), isNull(hourEntries.voidedAt))),
  ]);

  const cellsByStaff = new Map<string, Map<string, (typeof cells)[number]>>();
  for (const cell of cells) {
    const perStaff = cellsByStaff.get(cell.staffMemberId) ?? new Map();
    perStaff.set(cell.workDate, cell);
    cellsByStaff.set(cell.staffMemberId, perStaff);
  }

  const rows: GridRow[] = records.map((record) => {
    const perStaff = cellsByStaff.get(record.staffMemberId);
    return {
      staffMemberId: record.staffMemberId,
      recordId: record.recordId,
      name: record.name,
      rank: record.rank,
      category: record.category,
      group: groupForCategory(record.category),
      hourlyRate: record.hourlyRate,
      displayOrder: record.displayOrder,
      version: record.version,
      status: (isWeeklyStatus(record.status) ? record.status : "normal") as WeeklyStatus,
      statusNote: record.statusNote,
      totalMinutes: record.totalMinutes,
      amount: record.amount,
      days: days.map((workDate) => {
        const cell = perStaff?.get(workDate);
        return {
          workDate,
          minutes: cell?.minutes ?? 0,
          entryId: cell?.entryId ?? null,
          recordedByUsername: cell?.recordedByUsername ?? null,
          note: cell?.note ?? null,
        };
      }),
    };
  });

  const groups: GridGroup[] = (["HIGH_STAFF", "MID_STAFF", "LOW_STAFF"] as const)
    .map((group) => {
      const groupRows = rows.filter((row) => row.group === group);
      const counting = groupRows.filter((row) => statusCounts(row.status));
      return {
        group,
        // La tarifa del encabezado es la del grupo; dentro todos los rangos
        // de una misma familia cobran igual.
        hourlyRate: groupRows[0]?.hourlyRate ?? 0,
        memberCount: groupRows.length,
        totalMinutes: counting.reduce((sum, row) => sum + row.totalMinutes, 0),
        totalAmount: counting.reduce((sum, row) => sum + row.amount, 0),
        rows: groupRows,
      };
    })
    .filter((group) => group.rows.length > 0);

  const counting = rows.filter((row) => statusCounts(row.status));

  return {
    weekId: week.id,
    days,
    groups,
    totalMinutes: counting.reduce((sum, row) => sum + row.totalMinutes, 0),
    totalAmount: counting.reduce((sum, row) => sum + row.amount, 0),
    memberCount: rows.length,
    editable: week.status === "open",
  };
}

/* -------------------------------------------------------------------------- */
/* Escritura de una casilla                                                   */
/* -------------------------------------------------------------------------- */

export interface SetCellInput {
  readonly weekId: string;
  readonly staffMemberId: string;
  readonly workDate: string;
  readonly minutes: number;
  readonly note?: string | null;
}

/**
 * Escribe una casilla de la planilla.
 *
 * Poner 0 no deja un registro en cero: anula la entrada del día. Así la
 * auditoría distingue "nunca cargó ese día" de "cargó 3 h y alguien las borró",
 * que es justo lo que hay que poder responder después.
 */
export async function setGridCell(input: SetCellInput, actor: ActorContext): Promise<void> {
  if (!Number.isInteger(input.minutes) || input.minutes < 0) {
    throw validation("La duración debe ser un número entero de minutos.", {
      minutes: ["Valor inválido."],
    });
  }
  if (input.minutes > MAX_MINUTES_PER_ENTRY) {
    throw validation("Un día no puede superar las 24 horas.", {
      minutes: ["Cargaste " + formatMinutes(input.minutes) + " en un solo día."],
    });
  }

  await withTransaction(async (tx) => {
    const week = await loadWeekForWrite(tx, input.weekId);

    if (!isDateWithinPeriod(input.workDate, week.startDate, week.endDate)) {
      throw validation("Ese día no pertenece al período.", { workDate: ["Fecha fuera de rango."] });
    }

    const [member] = await tx
      .select({ id: staffMembers.id, name: staffMembers.name, archivedAt: staffMembers.archivedAt })
      .from(staffMembers)
      .where(eq(staffMembers.id, input.staffMemberId))
      .limit(1);

    if (!member) throw notFound("El miembro del staff");
    if (member.archivedAt) {
      throw businessRule(member.name + " está archivado y no puede recibir horas.");
    }

    const [previous] = await tx
      .select()
      .from(hourEntries)
      .where(
        and(
          eq(hourEntries.staffMemberId, input.staffMemberId),
          eq(hourEntries.weekId, input.weekId),
          eq(hourEntries.workDate, input.workDate),
          isNull(hourEntries.voidedAt),
        ),
      )
      .limit(1)
      .for("update");

    const previousMinutes = previous?.minutes ?? 0;
    if (previousMinutes === input.minutes && (previous?.reason ?? null) === (input.note ?? null)) {
      return; // Nada cambió: no se ensucia la auditoría con un registro vacío.
    }

    if (input.minutes === 0) {
      if (!previous) return;
      await tx
        .update(hourEntries)
        .set({
          voidedAt: new Date(),
          voidedBy: actor.id,
          voidReason: "Casilla puesta en cero desde la planilla",
          version: previous.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(hourEntries.id, previous.id));
    } else if (previous) {
      const [updated] = await tx
        .update(hourEntries)
        .set({
          minutes: input.minutes,
          reason: input.note ?? previous.reason,
          version: previous.version + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(hourEntries.id, previous.id), eq(hourEntries.version, previous.version)))
        .returning();

      if (!updated) throw concurrency();
    } else {
      await tx.insert(hourEntries).values({
        staffMemberId: input.staffMemberId,
        weekId: input.weekId,
        workDate: input.workDate,
        minutes: input.minutes,
        reason: input.note ?? null,
        recordedBy: actor.id,
        recordedByUsername: actor.username,
      });
    }

    await recalculateWeekRecords(tx, input.weekId);

    await appendAuditLog(tx, {
      actor,
      action:
        previousMinutes === 0
          ? "HOURS_LOGGED"
          : input.minutes === 0
            ? "HOURS_VOIDED"
            : "HOURS_UPDATED",
      entity: "hour_entries",
      entityId: previous?.id ?? input.staffMemberId,
      summary:
        member.name +
        " · " +
        formatCalendarDate(input.workDate) +
        ": " +
        formatMinutes(previousMinutes) +
        " → " +
        formatMinutes(input.minutes),
      before: { minutos: previousMinutes, duracion: formatMinutes(previousMinutes) },
      after: { minutos: input.minutes, duracion: formatMinutes(input.minutes) },
      metadata: { weekId: input.weekId, staffMemberId: input.staffMemberId, dia: input.workDate },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Estado semanal                                                             */
/* -------------------------------------------------------------------------- */

export async function setWeeklyStatus(
  input: { weekId: string; staffMemberId: string; status: WeeklyStatus; note?: string | null },
  actor: ActorContext,
): Promise<void> {
  await withTransaction(async (tx) => {
    await loadWeekForWrite(tx, input.weekId);

    const [record] = await tx
      .select()
      .from(weeklyStaffRecords)
      .where(
        and(
          eq(weeklyStaffRecords.weekId, input.weekId),
          eq(weeklyStaffRecords.staffMemberId, input.staffMemberId),
        ),
      )
      .limit(1)
      .for("update");

    if (!record) throw notFound("La liquidación de ese miembro");
    if (record.status === input.status && (record.statusNote ?? null) === (input.note ?? null)) {
      return;
    }

    await tx
      .update(weeklyStaffRecords)
      .set({
        status: input.status,
        statusNote: input.note ?? null,
        version: record.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(weeklyStaffRecords.id, record.id));

    // El importe depende del estado, así que se vuelve a calcular.
    await recalculateWeekRecords(tx, input.weekId);

    const definition = WEEKLY_STATUS_DEFINITIONS[input.status];

    await appendAuditLog(tx, {
      actor,
      action: "STAFF_UPDATED",
      entity: "weekly_staff_records",
      entityId: record.id,
      summary:
        record.staffNameSnapshot +
        ": " +
        statusLabel(record.status) +
        " → " +
        definition.short +
        (definition.counts ? "" : " (no cobra este período)"),
      before: { estado: record.status, importe: record.calculatedAmount },
      after: { estado: input.status, cobra: definition.counts },
      reason: input.note ?? null,
      metadata: { weekId: input.weekId, staffMemberId: input.staffMemberId },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Orden manual                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Reordena la lista. Se recibe el orden completo del grupo y se reescribe en un
 * solo statement: enviar movimientos sueltos ("subir uno") haría que dos
 * personas reordenando a la vez terminaran con posiciones cruzadas.
 */
export async function reorderStaff(
  staffMemberIds: readonly string[],
  actor: ActorContext,
): Promise<void> {
  if (staffMemberIds.length === 0) return;

  await withTransaction(async (tx) => {
    await applyOrder(tx, staffMemberIds);

    await appendAuditLog(tx, {
      actor,
      action: "STAFF_UPDATED",
      entity: "staff_members",
      entityId: staffMemberIds[0] ?? "",
      summary: "Reordenó la lista de staff (" + staffMemberIds.length + " posiciones)",
      after: { orden: staffMemberIds.length },
    });
  });
}

async function applyOrder(tx: Transaction, ids: readonly string[]): Promise<void> {
  const values = ids
    .map((id, index) => sql`(${id}::uuid, ${index}::int)`)
    .reduce((acc, part, index) => (index === 0 ? part : sql`${acc}, ${part}`));

  await tx.execute(sql`
    update staff_members
       set display_order = nuevo.posicion,
           updated_at = now()
      from (values ${values}) as nuevo(id, posicion)
     where staff_members.id = nuevo.id
  `);
}

/** Asigna un orden inicial coherente a quien todavía no lo tiene. */
export async function ensureDisplayOrder(): Promise<void> {
  await db.execute(sql`
    with ordenado as (
      select id, row_number() over (order by rank desc, name asc) * 10 as posicion
      from staff_members
      where display_order = 0
    )
    update staff_members
       set display_order = ordenado.posicion
      from ordenado
     where staff_members.id = ordenado.id
  `);
}

/** Valor que corresponde al final de la lista, para una alta nueva. */
export async function nextDisplayOrder(): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${staffMembers.displayOrder}), 0)::int` })
    .from(staffMembers);
  return (row?.max ?? 0) + 10;
}

/* -------------------------------------------------------------------------- */
/* Resumen para encabezados                                                   */
/* -------------------------------------------------------------------------- */

export function describeGroupTotals(group: GridGroup): string {
  return (
    formatMoney(group.hourlyRate) +
    "/hora · " +
    group.memberCount +
    (group.memberCount === 1 ? " usuario" : " usuarios")
  );
}
