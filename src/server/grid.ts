import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db, withTransaction, type Transaction } from "@/db";
import {
  hourEntries,
  rankRates,
  staffMembers,
  weeklyStaffRecords,
  weeks as weeksTable,
  type Week,
} from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import { businessRule, concurrency, notFound, validation } from "@/lib/core/errors";
import {
  DAY_STATUS_DEFINITIONS,
  groupForCategory,
  isDayStatus,
  statusCounts,
  type DayStatus,
  type StaffGroup,
} from "@/domain/groups";
import { eachDayOfPeriod, formatCalendarDate, isDateWithinPeriod } from "@/domain/periods";
import {
  categoryForRank,
  compareRankChange,
  rankBaseOrder,
  rankTier,
  type StaffRank,
} from "@/domain/ranks";
import { formatMinutes, MAX_MINUTES_PER_ENTRY } from "@/domain/time";
import { appendAuditLog } from "./audit";
import { loadWeekForWrite, recalculateWeekRecords } from "./weeks";

/**
 * IMPERIO RP — Planilla semanal de horas.
 *
 * Una fila por persona, una casilla por día. Cada casilla es una entrada real
 * de `hour_entries`, así que se conserva quién la cargó, cuándo y todo el
 * historial, sin obligar a describir un turno para anotar dos horas de un martes.
 *
 * El estado (inactivo, justificado, anulado) es del DÍA, no de la semana: una
 * ausencia justificada corresponde a una fecha concreta.
 */

export interface GridCell {
  readonly workDate: string;
  readonly minutes: number;
  readonly entryId: string | null;
  readonly status: DayStatus;
  readonly recordedByUsername: string | null;
}

export interface GridRow {
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly rankColor: string;
  readonly category: string;
  readonly group: StaffGroup;
  readonly hourlyRate: number;
  readonly version: number;
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
 * Arma la planilla en dos consultas, sin importar cuántas personas haya: una
 * trae las filas y otra todas las casillas. Pedir los días de cada persona por
 * separado sería una consulta por fila.
 */
export async function getWeekGrid(week: Week): Promise<WeekGrid> {
  const days = eachDayOfPeriod(week.startDate, week.endDate);

  const [records, cells] = await Promise.all([
    db
      .select({
        staffMemberId: weeklyStaffRecords.staffMemberId,
        name: weeklyStaffRecords.staffNameSnapshot,
        rank: weeklyStaffRecords.rankSnapshot,
        category: weeklyStaffRecords.categorySnapshot,
        hourlyRate: weeklyStaffRecords.hourlyRateSnapshot,
        totalMinutes: weeklyStaffRecords.totalMinutes,
        amount: weeklyStaffRecords.calculatedAmount,
        displayOrder: staffMembers.displayOrder,
        version: staffMembers.version,
        rankColor: rankRates.color,
      })
      .from(weeklyStaffRecords)
      .innerJoin(staffMembers, eq(weeklyStaffRecords.staffMemberId, staffMembers.id))
      .leftJoin(rankRates, eq(rankRates.rank, weeklyStaffRecords.rankSnapshot))
      .where(eq(weeklyStaffRecords.weekId, week.id)),

    db
      .select({
        staffMemberId: hourEntries.staffMemberId,
        workDate: hourEntries.workDate,
        minutes: hourEntries.minutes,
        entryId: hourEntries.id,
        status: hourEntries.status,
        recordedByUsername: hourEntries.recordedByUsername,
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
      name: record.name,
      rank: record.rank,
      rankColor: record.rankColor ?? "#6f747d",
      category: record.category,
      group: groupForCategory(record.category),
      hourlyRate: record.hourlyRate,
      version: record.version,
      totalMinutes: record.totalMinutes,
      amount: record.amount,
      days: days.map((workDate) => {
        const cell = perStaff?.get(workDate);
        return {
          workDate,
          minutes: cell?.minutes ?? 0,
          entryId: cell?.entryId ?? null,
          status: (isDayStatus(cell?.status) ? cell.status : "normal") as DayStatus,
          recordedByUsername: cell?.recordedByUsername ?? null,
        };
      }),
    };
  });

  /** El orden manual, en un índice. Buscarlo en la lista dentro del
      comparador costaba una recorrida entera por comparación. */
  const manualOrder = new Map(records.map((record) => [record.staffMemberId, record.displayOrder]));

  /**
   * Orden dentro de cada grupo: manda el orden manual.
   *
   * Antes mandaba el rango y el orden manual sólo desempataba, pero dentro de
   * un grupo casi nunca hay dos personas del mismo rango: arrastrar decía
   * "orden actualizado" y no movía nada. Ahora el rango define la POSICIÓN
   * INICIAL —cada uno arranca en el escalón de su rango, así que la lista se
   * ve ordenada por jerarquía sin que nadie haga nada— y a partir de ahí el
   * equipo la acomoda como quiera.
   */
  const byRankThenManual = (a: GridRow, b: GridRow): number => {
    const orderA = manualOrder.get(a.staffMemberId) ?? rankBaseOrder(a.rank);
    const orderB = manualOrder.get(b.staffMemberId) ?? rankBaseOrder(b.rank);
    if (orderA !== orderB) return orderA - orderB;

    const tierDelta = rankTier(b.rank) - rankTier(a.rank);
    if (tierDelta !== 0) return tierDelta;

    return a.name.localeCompare(b.name, "es");
  };

  // Una sola recorrida reparte las filas y suma los totales, en vez de tres
  // filtrados más dos reducciones por grupo.
  const buckets = new Map<StaffGroup, GridRow[]>();
  let totalMinutes = 0;
  let totalAmount = 0;
  for (const row of rows) {
    const bucket = buckets.get(row.group);
    if (bucket) bucket.push(row);
    else buckets.set(row.group, [row]);
    totalMinutes += row.totalMinutes;
    totalAmount += row.amount;
  }

  const groups: GridGroup[] = [];
  for (const group of ["HIGH_STAFF", "MID_STAFF", "LOW_STAFF"] as const) {
    const groupRows = buckets.get(group);
    if (!groupRows || groupRows.length === 0) continue;

    groupRows.sort(byRankThenManual);

    let groupMinutes = 0;
    let groupAmount = 0;
    for (const row of groupRows) {
      groupMinutes += row.totalMinutes;
      groupAmount += row.amount;
    }

    groups.push({
      group,
      hourlyRate: groupRows[0]?.hourlyRate ?? 0,
      memberCount: groupRows.length,
      totalMinutes: groupMinutes,
      totalAmount: groupAmount,
      rows: groupRows,
    });
  }

  return {
    weekId: week.id,
    days,
    groups,
    totalMinutes,
    totalAmount,
    memberCount: rows.length,
    editable: week.status === "open",
  };
}

/* -------------------------------------------------------------------------- */
/* Escritura de una casilla                                                   */
/* -------------------------------------------------------------------------- */

async function loadMember(tx: Transaction, staffMemberId: string) {
  const [member] = await tx
    .select()
    .from(staffMembers)
    .where(eq(staffMembers.id, staffMemberId))
    .limit(1)
    .for("update");

  if (!member) throw notFound("El miembro del staff");
  return member;
}

/** Entrada vigente de un día, si existe. */
async function loadCell(tx: Transaction, weekId: string, staffMemberId: string, workDate: string) {
  const [entry] = await tx
    .select()
    .from(hourEntries)
    .where(
      and(
        eq(hourEntries.staffMemberId, staffMemberId),
        eq(hourEntries.weekId, weekId),
        eq(hourEntries.workDate, workDate),
        isNull(hourEntries.voidedAt),
      ),
    )
    .limit(1)
    .for("update");

  return entry ?? null;
}

export interface SetCellInput {
  readonly weekId: string;
  readonly staffMemberId: string;
  readonly workDate: string;
  readonly minutes: number;
}

/**
 * Escribe las horas de una casilla.
 *
 * Poner cero no deja un registro vacío: anula la entrada, salvo que el día
 * tenga un estado marcado que haya que conservar. Así la auditoría distingue
 * "nunca cargó ese día" de "cargó 3 h y alguien las borró".
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

    const member = await loadMember(tx, input.staffMemberId);
    if (member.archivedAt) {
      throw businessRule(member.name + " está archivado y no puede recibir horas.");
    }

    const previous = await loadCell(tx, input.weekId, input.staffMemberId, input.workDate);
    const previousMinutes = previous?.minutes ?? 0;
    if (previousMinutes === input.minutes) return;

    if (previous) {
      // Si queda en cero y el día no tiene estado que preservar, se anula.
      if (input.minutes === 0 && previous.status === "normal") {
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
      } else {
        /**
         * Escribir horas en un día marcado como "todavía no estaba" lo vuelve
         * normal. Esa marca la pone el sistema al incorporar a alguien a un
         * período ya empezado; si después resulta que sí estuvo, cargar las
         * horas tiene que alcanzar para que cuenten y se paguen, sin obligar a
         * un segundo click derecho que nadie recuerda hacer.
         *
         * Las otras marcas —inactivo, justificada, anulado— las puso una
         * persona a propósito y se respetan.
         */
        const status =
          previous.status === "no_ingresado" && input.minutes > 0 ? "normal" : previous.status;

        const [updated] = await tx
          .update(hourEntries)
          .set({
            minutes: input.minutes,
            status,
            version: previous.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(hourEntries.id, previous.id), eq(hourEntries.version, previous.version)))
          .returning();
        if (!updated) throw concurrency();
      }
    } else {
      if (input.minutes === 0) return;
      await tx.insert(hourEntries).values({
        staffMemberId: input.staffMemberId,
        weekId: input.weekId,
        workDate: input.workDate,
        minutes: input.minutes,
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
      before: { minutos: previousMinutes },
      after: { minutos: input.minutes },
      metadata: { weekId: input.weekId, staffMemberId: input.staffMemberId, dia: input.workDate },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Estado de un día                                                           */
/* -------------------------------------------------------------------------- */

export interface SetDayStatusInput {
  readonly weekId: string;
  readonly staffMemberId: string;
  readonly workDate: string;
  readonly status: DayStatus;
}

/**
 * Marca un día como inactivo, justificado o anulado.
 *
 * Un día marcado deja de sumar horas y de pagarse, pero la cantidad cargada se
 * conserva: después se puede ver que tenía 3 h y por qué no se pagaron.
 */
export async function setDayStatus(input: SetDayStatusInput, actor: ActorContext): Promise<void> {
  await withTransaction(async (tx) => {
    const week = await loadWeekForWrite(tx, input.weekId);
    if (!isDateWithinPeriod(input.workDate, week.startDate, week.endDate)) {
      throw validation("Ese día no pertenece al período.", { workDate: ["Fecha fuera de rango."] });
    }

    const member = await loadMember(tx, input.staffMemberId);
    const previous = await loadCell(tx, input.weekId, input.staffMemberId, input.workDate);
    const previousStatus = (previous?.status ?? "normal") as DayStatus;

    if (previousStatus === input.status) return;

    if (previous) {
      // Volver a normal un día sin horas no deja rastro inútil: se anula.
      if (input.status === "normal" && previous.minutes === 0) {
        await tx
          .update(hourEntries)
          .set({
            voidedAt: new Date(),
            voidedBy: actor.id,
            voidReason: "Marca de estado retirada desde la planilla",
            version: previous.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(hourEntries.id, previous.id));
      } else {
        await tx
          .update(hourEntries)
          .set({ status: input.status, version: previous.version + 1, updatedAt: new Date() })
          .where(eq(hourEntries.id, previous.id));
      }
    } else {
      if (input.status === "normal") return;
      // Un día sin horas pero marcado necesita una fila que sostenga la marca.
      await tx.insert(hourEntries).values({
        staffMemberId: input.staffMemberId,
        weekId: input.weekId,
        workDate: input.workDate,
        minutes: 0,
        status: input.status,
        recordedBy: actor.id,
        recordedByUsername: actor.username,
      });
    }

    await recalculateWeekRecords(tx, input.weekId);

    const definition = DAY_STATUS_DEFINITIONS[input.status];

    await appendAuditLog(tx, {
      actor,
      action: "HOURS_UPDATED",
      entity: "hour_entries",
      entityId: previous?.id ?? input.staffMemberId,
      summary:
        member.name +
        " · " +
        formatCalendarDate(input.workDate) +
        ": " +
        definition.short +
        (statusCounts(input.status) ? "" : " (no cuenta)"),
      before: { estado: previousStatus, minutos: previous?.minutes ?? 0 },
      after: { estado: input.status, cuenta: definition.counts },
      metadata: { weekId: input.weekId, staffMemberId: input.staffMemberId, dia: input.workDate },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Cambio de rango desde la planilla                                          */
/* -------------------------------------------------------------------------- */

export async function changeRankFromGrid(
  input: { staffMemberId: string; rank: StaffRank; weekId: string },
  actor: ActorContext,
): Promise<void> {
  await withTransaction(async (tx) => {
    const member = await loadMember(tx, input.staffMemberId);

    if (member.rank === input.rank) return;
    if (member.archivedAt) {
      throw businessRule("No se puede cambiar el rango de un miembro archivado.");
    }

    const changeType = compareRankChange(member.rank, input.rank);

    await tx
      .update(staffMembers)
      .set({
        rank: input.rank,
        category: categoryForRank(input.rank),
        /**
         * Al cambiar de rango vuelve al escalón del rango nuevo. Si conservara
         * su posición anterior, un ascenso de MOD a ADM++ lo dejaría al final
         * del bloque High con una posición que ya no significa nada.
         */
        displayOrder: rankBaseOrder(input.rank),
        version: member.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(staffMembers.id, member.id));

    await tx.execute(sql`
      insert into staff_rank_history
        (staff_member_id, from_rank, to_rank, change_type, reason, changed_by, changed_by_username, week_id)
      values (
        ${member.id}::uuid, ${member.rank}, ${input.rank}, ${changeType},
        'Cambio desde la planilla de horas', ${actor.id}::uuid, ${actor.username}, ${input.weekId}::uuid
      )
    `);

    // La tarifa cambia con el rango, así que los períodos abiertos se recalculan.
    const openWeeks = await tx
      .select({ id: sql<string>`id` })
      .from(sql`weeks`)
      .where(sql`status = 'open'`);
    for (const open of openWeeks) {
      await recalculateWeekRecords(tx, open.id);
    }

    await appendAuditLog(tx, {
      actor,
      action: "STAFF_RANK_CHANGED",
      entity: "staff_members",
      entityId: member.id,
      summary: "Cambió el rango de " + member.name + ": " + member.rank + " → " + input.rank,
      before: { rango: member.rank, categoria: member.category },
      after: { rango: input.rank, categoria: categoryForRank(input.rank) },
      metadata: { tipoDeCambio: changeType, desde: "planilla" },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Orden manual                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Reordena la lista. Se recibe el orden completo del grupo y se reescribe de
 * una vez: enviar movimientos sueltos ("subir uno") haría que dos personas
 * reordenando a la vez terminaran con posiciones cruzadas.
 */
export async function reorderStaff(
  staffMemberIds: readonly string[],
  actor: ActorContext,
): Promise<void> {
  if (staffMemberIds.length === 0) return;

  await withTransaction(async (tx) => {
    const values = staffMemberIds
      .map((id, index) => sql`(${id}::uuid, ${index}::int)`)
      .reduce((acc, part, index) => (index === 0 ? part : sql`${acc}, ${part}`));

    await tx.execute(sql`
      update staff_members
         set display_order = nuevo.posicion, updated_at = now()
        from (values ${values}) as nuevo(id, posicion)
       where staff_members.id = nuevo.id
    `);

    await appendAuditLog(tx, {
      actor,
      action: "STAFF_UPDATED",
      entity: "staff_members",
      entityId: staffMemberIds[0] ?? "",
      summary: "Reordenó la lista de staff (" + staffMemberIds.length + " posiciones)",
      after: { posiciones: staffMemberIds.length },
    });
  });
}

export async function nextDisplayOrder(): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${staffMembers.displayOrder}), 0)::int` })
    .from(staffMembers);
  return (row?.max ?? 0) + 10;
}

/* -------------------------------------------------------------------------- */
/* Reinicio de la semana                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Deja todas las horas del período en cero y quita las marcas de estado.
 *
 * Los miembros permanecen en la planilla. Nada se borra: las entradas se anulan
 * con motivo, así que el historial sigue explicando qué había antes del
 * reinicio y quién lo hizo.
 */
export async function resetWeekHours(
  weekId: string,
  actor: ActorContext,
): Promise<{ cleared: number }> {
  return withTransaction(async (tx) => {
    const week = await loadWeekForWrite(tx, weekId);

    const cleared = await tx
      .update(hourEntries)
      .set({
        voidedAt: new Date(),
        voidedBy: actor.id,
        voidReason: "Reinicio de las horas del período",
        updatedAt: new Date(),
      })
      .where(and(eq(hourEntries.weekId, weekId), isNull(hourEntries.voidedAt)))
      .returning({ id: hourEntries.id });

    await recalculateWeekRecords(tx, weekId);

    await appendAuditLog(tx, {
      actor,
      action: "HOURS_VOIDED",
      entity: "weeks",
      entityId: weekId,
      summary:
        "Reinició las horas del período " +
        week.code +
        " (" +
        cleared.length +
        " registros anulados)",
      after: { registrosAnulados: cleared.length },
      reason: "Reinicio manual desde Configuración",
    });

    return { cleared: cleared.length };
  });
}

export { asc };

/* -------------------------------------------------------------------------- */
/* Incorporación a un período ya empezado                                     */
/* -------------------------------------------------------------------------- */

/**
 * Suma a alguien a un período en curso y marca los días anteriores a su ingreso.
 *
 * Si se une un jueves, el lunes a miércoles no quedan en 0:00 —que se leería
 * como "no trabajó"— sino como "todavía no estaba". Es la diferencia entre
 * alguien que faltó y alguien que ni siquiera formaba parte del staff.
 *
 * Se llama al dar de alta a un miembro y al incorporarlo a mano al período.
 */
export async function joinStaffToOpenWeek(
  tx: Transaction,
  staffMemberId: string,
  today: string,
): Promise<{ weekId: string; markedDays: number } | null> {
  const [week] = await tx
    .select()
    .from(weeksTable)
    .where(eq(weeksTable.status, "open"))
    .orderBy(sql`start_date desc`)
    .limit(1);

  if (!week) return null;

  await tx.execute(sql`
    insert into weekly_staff_records (
      week_id, staff_member_id, staff_name_snapshot, rank_snapshot, category_snapshot,
      hourly_rate_snapshot, total_minutes, calculated_amount, entry_count
    )
    select ${week.id}::uuid, s.id, s.name, s.rank, s.category, r.rate_per_hour, 0, 0, 0
    from staff_members s
    join rank_rates r on r.rank = s.rank
    where s.id = ${staffMemberId}::uuid
    on conflict (week_id, staff_member_id) do nothing
  `);

  // Los días del período anteriores a hoy quedan marcados.
  const previousDays = eachDayOfPeriod(week.startDate, week.endDate).filter((day) => day < today);

  for (const day of previousDays) {
    await tx
      .insert(hourEntries)
      .values({
        staffMemberId,
        weekId: week.id,
        workDate: day,
        minutes: 0,
        status: "no_ingresado",
        recordedBy: null,
        recordedByUsername: "sistema",
      })
      .onConflictDoNothing();
  }

  await recalculateWeekRecords(tx, week.id);

  return { weekId: week.id, markedDays: previousDays.length };
}
