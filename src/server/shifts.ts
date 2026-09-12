import { and, asc, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { db, withTransaction, type Transaction } from "@/db";
import { hourEntries, shiftSessions, staffMembers, weeklyStaffRecords, weeks } from "@/db/schema";
import { businessRule, conflict, isUniqueViolation, notFound } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";
import {
  formatDuration,
  localDate,
  previousLocalDate,
  secondsToMinutes,
  splitByLocalDay,
} from "@/domain/clock";
import { groupForRank, type StaffGroup } from "@/domain/groups";
import { rankTier } from "@/domain/ranks";
import { recalculateWeekRecords, weekBreakdowns } from "./weeks";

/**
 * IMPERIO RP — Fichajes.
 *
 * Entrada y salida desde Discord. La regla de fondo es una sola: el fichaje es
 * la fuente del tiempo, y la planilla es donde ese tiempo aterriza.
 *
 * CÓMO SE CUENTAN LAS HORAS, que es lo único que no puede fallar acá:
 *
 *   1. Al cerrar, el turno se parte por las medianoches LOCALES que cruce. Un
 *      turno de 22:00 a 02:00 son dos horas de cada día; si esa medianoche es
 *      la del sábado, además son dos liquidaciones distintas.
 *   2. Cada pedazo suma sus SEGUNDOS a la casilla de su día. Se acumulan
 *      segundos y no minutos porque redondear turno a turno va perdiendo
 *      tiempo; `minutes` se deriva del total de segundos, así que nunca hay dos
 *      números que puedan contradecirse.
 *   3. El pedazo que cae fuera de todo período abierto no se pierde en
 *      silencio: se informa, y el turno queda marcado como aplicado igual para
 *      que nadie lo sume dos veces.
 *   4. `applied` y el candado sobre la fila hacen que cerrar dos veces el mismo
 *      turno —dos clicks, un reintento de red— no duplique nada.
 */

/**
 * Más de esto abierto y el fichaje se cierra solo: alguien se olvidó de salir.
 *
 * El número NO se dice en ningún mensaje del bot, a propósito. Un límite
 * anunciado es un límite que se puede aprovechar: sabiendo que corta en 16, se
 * puede dejar abierto sin dar salida y quedarse con las horas justas por debajo.
 * Sin el número a la vista, olvidarse de salir es un problema y no una táctica.
 */
export const MAX_SHIFT_HOURS = 16;

export interface ShiftMember {
  readonly id: string;
  readonly name: string;
  readonly rank: string;
  readonly group: StaffGroup;
  readonly discordUserId: string | null;
}

export interface OpenShift {
  readonly id: string;
  readonly staffMemberId: string;
  readonly startedAt: Date;
  readonly seconds: number;
}

/* -------------------------------------------------------------------------- */
/* Identificación                                                             */
/* -------------------------------------------------------------------------- */

/** La ficha de staff vinculada a una cuenta de Discord. */
export async function findMemberByDiscord(discordUserId: string): Promise<ShiftMember | null> {
  const [row] = await db
    .select({
      id: staffMembers.id,
      name: staffMembers.name,
      rank: staffMembers.rank,
      discordUserId: staffMembers.discordUserId,
    })
    .from(staffMembers)
    .where(and(eq(staffMembers.discordUserId, discordUserId), isNull(staffMembers.archivedAt)))
    .limit(1);

  if (!row) return null;
  return { ...row, group: groupForRank(row.rank) };
}

/**
 * Vincula una cuenta de Discord con una ficha de staff.
 *
 * Se guarda el número de Discord y no el nombre: los nombres se cambian y el
 * número no. Si esa cuenta ya estaba vinculada a otra ficha, se suelta la
 * anterior, porque una persona es una sola.
 */
export async function linkDiscordAccount(
  staffMemberId: string,
  discordUserId: string,
  discordTag: string | null,
): Promise<ShiftMember> {
  return withTransaction(async (tx) => {
    await tx
      .update(staffMembers)
      .set({ discordUserId: null })
      .where(and(eq(staffMembers.discordUserId, discordUserId), isNull(staffMembers.archivedAt)));

    const [row] = await tx
      .update(staffMembers)
      .set({
        discordUserId,
        ...(discordTag ? { discordTag: discordTag.slice(0, 40) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(staffMembers.id, staffMemberId), isNull(staffMembers.archivedAt)))
      .returning({
        id: staffMembers.id,
        name: staffMembers.name,
        rank: staffMembers.rank,
        discordUserId: staffMembers.discordUserId,
      });

    if (!row) throw notFound("El miembro del staff");
    return { ...row, group: groupForRank(row.rank) };
  });
}

export async function unlinkDiscordAccount(discordUserId: string): Promise<number> {
  const filas = await db
    .update(staffMembers)
    .set({ discordUserId: null, updatedAt: new Date() })
    .where(eq(staffMembers.discordUserId, discordUserId))
    .returning({ id: staffMembers.id });
  return filas.length;
}

/** Fichas sin cuenta de Discord, para el buscador del panel de administración. */
export async function listUnlinkedMembers(
  search: string | null,
  limit = 25,
): Promise<readonly ShiftMember[]> {
  const filtro = search?.trim().toLowerCase();
  const rows = await db
    .select({
      id: staffMembers.id,
      name: staffMembers.name,
      rank: staffMembers.rank,
      discordUserId: staffMembers.discordUserId,
    })
    .from(staffMembers)
    .where(
      and(
        isNull(staffMembers.archivedAt),
        filtro ? sql`lower(${staffMembers.name}) like ${"%" + filtro + "%"}` : undefined,
      ),
    )
    .orderBy(asc(staffMembers.displayOrder), asc(staffMembers.name))
    .limit(limit);

  return rows.map((row) => ({ ...row, group: groupForRank(row.rank) }));
}

/* -------------------------------------------------------------------------- */
/* Abrir y cerrar                                                             */
/* -------------------------------------------------------------------------- */

export interface StartResult {
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly member: ShiftMember;
}

export async function startShift(input: {
  readonly member: ShiftMember;
  readonly discordUserId: string;
  readonly discordUsername: string;
}): Promise<StartResult> {
  const ahora = new Date();

  try {
    const [creado] = await db
      .insert(shiftSessions)
      .values({
        staffMemberId: input.member.id,
        startedAt: ahora,
        startDate: localDate(ahora),
        source: "discord",
        discordUserId: input.discordUserId,
        discordUsername: input.discordUsername.slice(0, 64),
      })
      .returning({ id: shiftSessions.id, startedAt: shiftSessions.startedAt });

    if (!creado) throw new Error("No se pudo abrir el fichaje.");
    return { sessionId: creado.id, startedAt: creado.startedAt, member: input.member };
  } catch (error) {
    /**
     * El índice único es el que decide, no una consulta previa: dos clicks
     * seguidos llegan juntos y los dos verían "no hay ninguno abierto". El
     * mensaje para la persona sale de acá.
     */
    if (isUniqueViolation(error)) {
      throw conflict("Ya tenés un fichaje abierto. Cerralo antes de abrir otro.");
    }
    throw error;
  }
}

export async function getOpenShift(staffMemberId: string): Promise<OpenShift | null> {
  const [row] = await db
    .select({
      id: shiftSessions.id,
      staffMemberId: shiftSessions.staffMemberId,
      startedAt: shiftSessions.startedAt,
    })
    .from(shiftSessions)
    .where(and(eq(shiftSessions.staffMemberId, staffMemberId), isNull(shiftSessions.endedAt)))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    staffMemberId: row.staffMemberId,
    startedAt: row.startedAt,
    seconds: Math.max(0, Math.round((Date.now() - row.startedAt.getTime()) / 1000)),
  };
}

export interface CloseResult {
  readonly sessionId: string;
  readonly member: ShiftMember;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly seconds: number;
  readonly duration: string;
  /** Qué se sumó a cada día. Vacío si el turno cayó fuera de todo período. */
  readonly applied: readonly { readonly workDate: string; readonly seconds: number }[];
  /** Días que quedaron fuera de un período abierto, para poder avisar. */
  readonly skipped: readonly string[];
  readonly reason: "normal" | "forzado" | "automatico";
}

export async function closeShift(input: {
  readonly staffMemberId: string;
  readonly closedByDiscordId?: string | undefined;
  readonly reason?: "normal" | "forzado" | "automatico";
  readonly at?: Date;
}): Promise<CloseResult> {
  const reason = input.reason ?? "normal";

  return withTransaction(async (tx) => {
    const [sesion] = await tx
      .select()
      .from(shiftSessions)
      .where(
        and(eq(shiftSessions.staffMemberId, input.staffMemberId), isNull(shiftSessions.endedAt)),
      )
      .limit(1)
      .for("update");

    if (!sesion) throw businessRule("No tenés ningún fichaje abierto.");

    const [ficha] = await tx
      .select({
        id: staffMembers.id,
        name: staffMembers.name,
        rank: staffMembers.rank,
        discordUserId: staffMembers.discordUserId,
      })
      .from(staffMembers)
      .where(eq(staffMembers.id, sesion.staffMemberId))
      .limit(1);

    if (!ficha) throw notFound("El miembro del staff");

    const endedAt = input.at ?? new Date();
    const seconds = Math.max(
      0,
      Math.round((endedAt.getTime() - sesion.startedAt.getTime()) / 1000),
    );

    const { applied, skipped } = await applySegments(
      tx,
      sesion.staffMemberId,
      splitByLocalDay(sesion.startedAt, endedAt),
    );

    await tx
      .update(shiftSessions)
      .set({
        endedAt,
        seconds,
        applied: true,
        closeReason: reason,
        closedByDiscordId: input.closedByDiscordId ?? null,
        version: sesion.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(shiftSessions.id, sesion.id));

    return {
      sessionId: sesion.id,
      member: { ...ficha, group: groupForRank(ficha.rank) },
      startedAt: sesion.startedAt,
      endedAt,
      seconds,
      duration: formatDuration(seconds),
      applied,
      skipped,
      reason,
    };
  });
}

/**
 * Suma los segundos de cada pedazo del turno a la casilla de su día.
 *
 * `minutes` se recalcula siempre desde el total de segundos: es una vista, no
 * un segundo número que haya que mantener en línea a mano.
 */
async function applySegments(
  tx: Transaction,
  staffMemberId: string,
  segmentos: readonly { workDate: string; seconds: number }[],
): Promise<{
  applied: { workDate: string; seconds: number }[];
  skipped: string[];
}> {
  const applied: { workDate: string; seconds: number }[] = [];
  const skipped: string[] = [];
  const semanasTocadas = new Set<string>();

  for (const segmento of segmentos) {
    if (segmento.seconds <= 0) continue;

    const [semana] = await tx
      .select({ id: weeks.id })
      .from(weeks)
      .where(
        and(
          sql`${weeks.startDate} <= ${segmento.workDate}`,
          sql`${weeks.endDate} >= ${segmento.workDate}`,
          eq(weeks.status, "open"),
        ),
      )
      .limit(1);

    if (!semana) {
      // Sin período abierto que lo contenga no hay dónde anotarlo. Se informa
      // en vez de descartarlo callado: el turno queda en el historial y alguien
      // puede cargarlo a mano.
      skipped.push(segmento.workDate);
      continue;
    }

    const [existente] = await tx
      .select()
      .from(hourEntries)
      .where(
        and(
          eq(hourEntries.staffMemberId, staffMemberId),
          eq(hourEntries.weekId, semana.id),
          eq(hourEntries.workDate, segmento.workDate),
          isNull(hourEntries.voidedAt),
        ),
      )
      .limit(1)
      .for("update");

    if (existente) {
      const segundos = existente.seconds + segmento.seconds;
      await tx
        .update(hourEntries)
        .set({
          seconds: segundos,
          minutes: secondsToMinutes(segundos),
          /**
           * Fichar en un día marcado "todavía no estaba" lo vuelve normal: si
           * la persona estuvo trabajando, ese día cuenta.
           */
          status: existente.status === "no_ingresado" ? "normal" : existente.status,
          version: existente.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(hourEntries.id, existente.id));
    } else {
      await tx.insert(hourEntries).values({
        staffMemberId,
        weekId: semana.id,
        workDate: segmento.workDate,
        seconds: segmento.seconds,
        minutes: secondsToMinutes(segmento.seconds),
        recordedByUsername: "discord",
      });
    }

    semanasTocadas.add(semana.id);
    applied.push({ workDate: segmento.workDate, seconds: segmento.seconds });
  }

  for (const weekId of semanasTocadas) {
    await recalculateWeekRecords(tx, weekId);
  }

  return { applied, skipped };
}

/* -------------------------------------------------------------------------- */
/* Consultas para los paneles                                                 */
/* -------------------------------------------------------------------------- */

export interface ActiveShift {
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly group: StaffGroup;
  readonly discordUserId: string | null;
  readonly startedAt: Date;
  readonly seconds: number;
}

/** Quiénes están fichados ahora mismo. Opcionalmente, sólo los de un bloque. */
export async function listActiveShifts(group?: StaffGroup): Promise<readonly ActiveShift[]> {
  const rows = await db
    .select({
      staffMemberId: shiftSessions.staffMemberId,
      name: staffMembers.name,
      rank: staffMembers.rank,
      discordUserId: staffMembers.discordUserId,
      startedAt: shiftSessions.startedAt,
    })
    .from(shiftSessions)
    .innerJoin(staffMembers, eq(staffMembers.id, shiftSessions.staffMemberId))
    .where(isNull(shiftSessions.endedAt))
    .orderBy(asc(shiftSessions.startedAt));

  const ahora = Date.now();

  return rows
    .map((row) => ({
      ...row,
      group: groupForRank(row.rank),
      seconds: Math.max(0, Math.round((ahora - row.startedAt.getTime()) / 1000)),
    }))
    .filter((row) => (group ? row.group === group : true));
}

export interface DailyLine {
  readonly staffMemberId: string;
  readonly name: string;
  readonly rank: string;
  readonly group: StaffGroup;
  readonly seconds: number;
}

/**
 * Lo que trabajó cada uno en un día, para el reporte de medianoche.
 *
 * Se arma con los fichajes cerrados de ese día —el tiempo realmente medido— y
 * no con la casilla de la planilla, que puede tener correcciones a mano de
 * otros días o cargas manuales.
 */
export async function dailyReport(
  workDate: string,
  group?: StaffGroup,
): Promise<readonly DailyLine[]> {
  const rows = await db
    .select({
      staffMemberId: shiftSessions.staffMemberId,
      name: staffMembers.name,
      rank: staffMembers.rank,
      seconds: sql<number>`sum(${shiftSessions.seconds})::int`,
    })
    .from(shiftSessions)
    .innerJoin(staffMembers, eq(staffMembers.id, shiftSessions.staffMemberId))
    .where(and(eq(shiftSessions.startDate, workDate), sql`${shiftSessions.endedAt} is not null`))
    .groupBy(shiftSessions.staffMemberId, staffMembers.name, staffMembers.rank);

  return rows
    .map((row) => ({ ...row, group: groupForRank(row.rank) }))
    .filter((row) => (group ? row.group === group : true))
    .sort((a, b) => b.seconds - a.seconds || rankTier(b.rank) - rankTier(a.rank));
}

/** Los últimos turnos de una persona, para que pueda revisarlos. */
export async function recentShifts(staffMemberId: string, limit = 8) {
  return db
    .select({
      startedAt: shiftSessions.startedAt,
      endedAt: shiftSessions.endedAt,
      seconds: shiftSessions.seconds,
      startDate: shiftSessions.startDate,
      closeReason: shiftSessions.closeReason,
    })
    .from(shiftSessions)
    .where(and(eq(shiftSessions.staffMemberId, staffMemberId), sql`ended_at is not null`))
    .orderBy(desc(shiftSessions.startedAt))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Mantenimiento                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Cierra los fichajes que quedaron abiertos demasiado tiempo.
 *
 * Alguien se olvida de darle a Salida y el turno sigue corriendo toda la noche.
 * Sin esto, la próxima vez que cierre se le sumarían catorce horas que no
 * trabajó, y el bloqueo de "un fichaje abierto por persona" le impediría volver
 * a entrar. Se cierra al tope y queda marcado como automático, así que se ve en
 * el registro que ese número no es de fiar.
 */
export async function autoCloseStaleShifts(): Promise<readonly CloseResult[]> {
  const limite = new Date(Date.now() - MAX_SHIFT_HOURS * 3600 * 1000);

  const abiertas = await db
    .select({ staffMemberId: shiftSessions.staffMemberId, startedAt: shiftSessions.startedAt })
    .from(shiftSessions)
    .where(and(isNull(shiftSessions.endedAt), sql`${shiftSessions.startedAt} < ${limite}`));

  const cerradas: CloseResult[] = [];

  for (const abierta of abiertas) {
    try {
      const resultado = await closeShift({
        staffMemberId: abierta.staffMemberId,
        reason: "automatico",
        // Se corta al tope, no en el momento de correr la limpieza.
        at: new Date(abierta.startedAt.getTime() + MAX_SHIFT_HOURS * 3600 * 1000),
      });
      cerradas.push(resultado);
    } catch (error) {
      logger.error("No se pudo cerrar un fichaje vencido", {
        staffMemberId: abierta.staffMemberId,
        error,
      });
    }
  }

  return cerradas;
}

/** El día local de ayer: lo que reporta la tarea de medianoche. */
export function yesterdayLocal(): string {
  return previousLocalDate(localDate());
}

/** Horas del período en curso de una persona, para `/mis-horas`. */
export async function periodSummary(staffMemberId: string): Promise<{
  readonly weekLabel: string | null;
  readonly seconds: number;
  readonly days: readonly { readonly workDate: string; readonly seconds: number }[];
} | null> {
  const semana = await currentPeriod();
  if (!semana) return null;

  const filas = await db
    .select({ workDate: hourEntries.workDate, seconds: hourEntries.seconds })
    .from(hourEntries)
    .where(
      and(
        eq(hourEntries.staffMemberId, staffMemberId),
        eq(hourEntries.weekId, semana.id),
        eq(hourEntries.status, "normal"),
        isNull(hourEntries.voidedAt),
        gte(hourEntries.seconds, 1),
      ),
    )
    .orderBy(asc(hourEntries.workDate));

  return {
    weekLabel: semana.startDate + " → " + semana.endDate,
    seconds: filas.reduce((suma, fila) => suma + fila.seconds, 0),
    days: filas,
  };
}

/**
 * El período en curso: el que contiene el día de hoy.
 *
 * Antes se tomaba el abierto con la fecha de inicio más nueva. Sirve mientras
 * haya uno solo, pero el día que se abre el siguiente sin cerrar el anterior
 * hay dos abiertos, y el criterio de "el más nuevo" elige uno que puede no
 * haber empezado todavía: alguien pregunta sus horas de hoy y el bot le
 * contesta las de un período que arranca el sábado que viene, o sea cero.
 *
 * El día de hoy es el que manda. Si ninguno lo contiene —un hueco entre
 * períodos, o el nuevo todavía sin crear— recién ahí se cae al más reciente,
 * que al menos es el último que existió.
 */
export async function currentPeriod(): Promise<{
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
} | null> {
  const hoy = localDate();

  const [contiene] = await db
    .select({ id: weeks.id, startDate: weeks.startDate, endDate: weeks.endDate })
    .from(weeks)
    .where(
      and(
        eq(weeks.status, "open"),
        sql`${weeks.startDate} <= ${hoy}`,
        sql`${weeks.endDate} >= ${hoy}`,
      ),
    )
    .orderBy(desc(weeks.startDate))
    .limit(1);

  if (contiene) return contiene;

  const [reciente] = await db
    .select({ id: weeks.id, startDate: weeks.startDate, endDate: weeks.endDate })
    .from(weeks)
    .where(eq(weeks.status, "open"))
    .orderBy(desc(weeks.startDate))
    .limit(1);

  return reciente ?? null;
}

/** La liquidación congelada de un período, para anunciarla al cerrarlo. */
export async function frozenSettlement(weekId: string): Promise<
  readonly {
    readonly name: string;
    readonly rank: string;
    readonly minutes: number;
    readonly amount: number;
  }[]
> {
  const filas = await db
    .select({
      name: weeklyStaffRecords.staffNameSnapshot,
      rank: weeklyStaffRecords.rankSnapshot,
      minutes: weeklyStaffRecords.totalMinutes,
      amount: weeklyStaffRecords.calculatedAmount,
    })
    .from(weeklyStaffRecords)
    .where(and(eq(weeklyStaffRecords.weekId, weekId), gte(weeklyStaffRecords.totalMinutes, 1)))
    .orderBy(desc(weeklyStaffRecords.calculatedAmount));

  return filas;
}

/** El identificador de un período a partir de su código. */
export async function findWeekByCode(code: string): Promise<string | null> {
  const [fila] = await db.select({ id: weeks.id }).from(weeks).where(eq(weeks.code, code)).limit(1);
  return fila?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* Estado del período, para Discord                                           */
/* -------------------------------------------------------------------------- */
/**
 * La foto del período en curso, la misma que muestra la página.
 *
 * Que el bot y la web cuenten cosas distintas es peor que no tener bot: la
 * primera vez que los números no coinciden, nadie vuelve a creerle a ninguno de
 * los dos. Por eso el desglose sale de la misma consulta que usa la pantalla de
 * períodos, no de una cuenta paralela escrita para el bot.
 */
export interface PeriodOverview {
  readonly startDate: string;
  readonly endDate: string;
  readonly totalMinutes: number;
  readonly totalAmount: number;
  readonly memberCount: number;
  readonly membersWithHours: number;
  readonly groups: readonly {
    readonly label: string;
    readonly minutes: number;
    readonly amount: number;
    readonly members: number;
  }[];
  readonly top: readonly {
    readonly name: string;
    readonly rank: string;
    readonly minutes: number;
  }[];
  /** Quiénes figuran en el período y todavía no cargaron ni un minuto. */
  readonly sinCargar: readonly { readonly name: string; readonly rank: string }[];
  readonly totalSinCargar: number;
}

export async function periodOverview(): Promise<PeriodOverview | null> {
  const semana = await currentPeriod();
  if (!semana) return null;

  const [desgloses, [totales], enCero] = await Promise.all([
    weekBreakdowns([semana.id]),
    db
      .select({
        memberCount: sql<number>`count(*)::int`,
        totalAmount:
          sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
            Number,
          ),
      })
      .from(weeklyStaffRecords)
      .where(eq(weeklyStaffRecords.weekId, semana.id)),
    db
      .select({
        name: weeklyStaffRecords.staffNameSnapshot,
        rank: weeklyStaffRecords.rankSnapshot,
      })
      .from(weeklyStaffRecords)
      .where(and(eq(weeklyStaffRecords.weekId, semana.id), eq(weeklyStaffRecords.totalMinutes, 0)))
      .orderBy(asc(weeklyStaffRecords.staffNameSnapshot)),
  ]);

  const desglose = desgloses.get(semana.id);

  return {
    startDate: semana.startDate,
    endDate: semana.endDate,
    totalMinutes: desglose?.totalMinutes ?? 0,
    totalAmount: totales?.totalAmount ?? 0,
    memberCount: totales?.memberCount ?? 0,
    membersWithHours: desglose?.membersWithHours ?? 0,
    groups: desglose?.groups ?? [],
    top: desglose?.top ?? [],
    // Ocho alcanzan para que se entienda; la lista completa está en la página.
    sinCargar: enCero.slice(0, 8),
    totalSinCargar: enCero.length,
  };
}
