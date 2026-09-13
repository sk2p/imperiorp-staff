import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { withTransaction } from "@/db";
import { weeklyStaffRecords, weeks } from "@/db/schema";
import { systemActor } from "@/lib/auth/context";
import { logger } from "@/lib/core/logger";
import { formatMoney } from "@/domain/money";
import {
  addDays,
  buildPeriodCode,
  calendarDateToUtc,
  formatPeriodLabel,
  periodLengthInDays,
  type CalendarDate,
} from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import { appendAuditLog } from "./audit";
import { recalculateWeekRecords } from "./weeks";

/**
 * IMPERIO RP — Rotación automática del período.
 *
 * Imperio RP liquida de sábado a viernes. Cada sábado el período que terminó se
 * cierra —congelando horas, rangos, tarifas e importes— y arranca el siguiente
 * con todo el staff activo en cero.
 *
 * La tarea corre a diario y decide por sí misma si corresponde actuar. Hacerlo
 * así, en vez de confiar en que se dispare exactamente el sábado, significa que
 * un día que el programador no corra —un despliegue, una caída— se recupera solo
 * a la mañana siguiente en lugar de dejar el período abierto una semana entera.
 */

/** Día de la semana en que rota el período. 6 = sábado. */
const ROTATION_WEEKDAY = 6;

/** Duración del período nuevo, en días. */
const PERIOD_LENGTH = 7;

export function isRotationDay(date: CalendarDate): boolean {
  return calendarDateToUtc(date).getUTCDay() === ROTATION_WEEKDAY;
}

export interface RotationResult {
  readonly acted: boolean;
  readonly reason: string;
  readonly closedWeek?: {
    readonly code: string;
    readonly minutes: number;
    readonly amount: number;
  };
  readonly openedWeek?: {
    readonly code: string;
    readonly startDate: string;
    readonly endDate: string;
  };
}

/**
 * Cierra el período vencido y abre el siguiente, si corresponde.
 *
 * Es idempotente: si ya se rotó hoy, no hace nada. Puede llamarse cuantas veces
 * se quiera sin duplicar períodos ni volver a cerrar lo cerrado.
 */
export async function rotatePeriodIfDue(
  today: CalendarDate = new Date().toISOString().slice(0, 10),
): Promise<RotationResult> {
  return withTransaction(async (tx) => {
    const [open] = await tx
      .select()
      .from(weeks)
      .where(eq(weeks.status, "open"))
      .orderBy(desc(weeks.startDate))
      .limit(1)
      .for("update");

    // Sin período abierto, se abre uno si hoy es el día de rotación.
    if (!open) {
      if (!isRotationDay(today)) {
        return { acted: false, reason: "No hay período abierto y hoy no es sábado." };
      }
      const opened = await openPeriod(tx, today);
      return {
        acted: true,
        reason: "No había período abierto: se abrió el de esta semana.",
        openedWeek: opened,
      };
    }

    // El período todavía no terminó.
    if (today <= open.endDate) {
      return {
        acted: false,
        reason:
          "El período " +
          formatPeriodLabel(open.startDate, open.endDate) +
          " sigue en curso hasta el " +
          open.endDate +
          ".",
      };
    }

    /**
     * El período venció. Se cierra aunque hoy no sea sábado: si el programador
     * no corrió el sábado, esperar al siguiente dejaría dos semanas mezcladas
     * en la misma liquidación.
     */
    const closed = await closePeriod(tx, open.id);
    const nextStart = isRotationDay(today) ? today : addDays(open.endDate, 1);
    const opened = await openPeriod(tx, nextStart);

    logger.info("Período rotado automáticamente", {
      cerrado: closed.code,
      abierto: opened.code,
    });

    return {
      acted: true,
      reason: "Se cerró el período vencido y se abrió el siguiente.",
      closedWeek: closed,
      openedWeek: opened,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Garantía de cobertura                                                      */
/* -------------------------------------------------------------------------- */

/** El sábado de la semana a la que pertenece una fecha. */
export function weekStartFor(date: CalendarDate): CalendarDate {
  // getUTCDay: 0 domingo … 6 sábado. Cuántos días hay que retroceder hasta el
  // sábado: el propio sábado retrocede cero, el domingo uno, el viernes seis.
  const diasAtras = (calendarDateToUtc(date).getUTCDay() + 1) % 7;
  return addDays(date, -diasAtras);
}

export interface EnsureResult {
  readonly created: boolean;
  readonly reason: string;
  readonly week?: {
    readonly code: string;
    readonly startDate: string;
    readonly endDate: string;
  };
}

/**
 * Se asegura de que el día de hoy caiga adentro de un período abierto.
 *
 * La rotación de los sábados cierra el que venció y abre el siguiente, y con
 * eso alcanza mientras nadie toque nada. Pero un período se puede borrar, o se
 * puede crear uno con las fechas corridas, y entonces queda un día sin cubrir.
 * Eso no es un detalle estético: un fichaje se anota en el período que CONTIENE
 * el día trabajado, así que un día sin cubrir es un día cuyas horas no se
 * cargan en ninguna planilla.
 *
 * Esto lo repara solo, y es deliberadamente lo más tímido que puede ser:
 *
 *   · No cierra nada. Cerrar congela una liquidación para siempre y ésa es una
 *     decisión de una persona, no de un reloj. De cerrar se ocupa la rotación,
 *     que lo hace en su día y lo anuncia.
 *   · Si la semana canónica —de sábado a viernes— pisa un período que ya
 *     existe, no se rinde ni lo pisa: recorta el rango a los días libres que
 *     rodean a hoy. Mejor cubrir tres días que ninguno.
 *   · Si hoy ya está adentro de un período abierto, no hace absolutamente nada.
 *     Se puede llamar cada diez minutos sin consecuencias.
 */
export async function ensureCurrentPeriod(
  today: CalendarDate = new Date().toISOString().slice(0, 10),
): Promise<EnsureResult> {
  return withTransaction(async (tx) => {
    /**
     * El candado de asesoramiento evita que dos procesos —el bot y la tarea de
     * la web— creen el mismo período a la vez. Se libera solo al terminar la
     * transacción, salga bien o salga mal.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('imperio:cobertura'))`);

    const [cubre] = await tx
      .select({ id: weeks.id })
      .from(weeks)
      .where(
        and(
          eq(weeks.status, "open"),
          sql`${weeks.startDate} <= ${today}`,
          sql`${weeks.endDate} >= ${today}`,
        ),
      )
      .limit(1);

    if (cubre) return { created: false, reason: "Hoy ya cae adentro de un período abierto." };

    const canonicoInicio = weekStartFor(today);
    const canonicoFin = addDays(canonicoInicio, PERIOD_LENGTH - 1);

    /**
     * Se recorta contra TODOS los períodos, abiertos y cerrados. Dos períodos
     * no pueden compartir un día ni aunque uno esté cerrado: las horas de ese
     * día no sabrían a cuál pertenecen.
     */
    const existentes = await tx
      .select({ startDate: weeks.startDate, endDate: weeks.endDate })
      .from(weeks)
      .where(
        and(sql`${weeks.startDate} <= ${canonicoFin}`, sql`${weeks.endDate} >= ${canonicoInicio}`),
      );

    let inicio = canonicoInicio;
    let fin = canonicoFin;

    for (const otro of existentes) {
      // Termina antes de hoy: empuja el arranque a partir del día siguiente.
      if (otro.endDate < today && otro.endDate >= inicio) inicio = addDays(otro.endDate, 1);
      // Empieza después de hoy: adelanta el cierre al día anterior.
      if (otro.startDate > today && otro.startDate <= fin) fin = addDays(otro.startDate, -1);
      // Contiene hoy: imposible, arriba se comprobó que no hay ninguno abierto
      // que lo contenga — pero puede haber uno CERRADO. Ahí no hay nada que
      // hacer sin pisarlo, y pisarlo no es decisión de un reloj.
      if (otro.startDate <= today && otro.endDate >= today) {
        return {
          created: false,
          reason:
            "Hoy cae adentro del período cerrado " +
            formatPeriodLabel(otro.startDate, otro.endDate) +
            ". Hay que reabrirlo o corregir sus fechas a mano.",
        };
      }
    }

    if (inicio > today || fin < today) {
      return { created: false, reason: "No queda ningún día libre alrededor de hoy." };
    }

    const abierto = await openPeriod(tx, inicio, fin);

    logger.info("Período creado automáticamente para cubrir el día", {
      hoy: today,
      periodo: abierto.code,
      recortado: inicio !== canonicoInicio || fin !== canonicoFin,
    });

    return {
      created: true,
      reason:
        inicio === canonicoInicio && fin === canonicoFin
          ? "Se abrió el período de esta semana."
          : "Se abrió un período recortado para no pisar otro ya existente.",
      week: abierto,
    };
  });
}

type Tx = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function closePeriod(tx: Tx, weekId: string) {
  const actor = systemActor("Cierre automático de período");

  await recalculateWeekRecords(tx, weekId);

  const now = new Date();
  await tx
    .update(weeklyStaffRecords)
    .set({ frozenAt: now })
    .where(and(eq(weeklyStaffRecords.weekId, weekId), isNull(weeklyStaffRecords.frozenAt)));

  const [totals] = await tx
    .select({
      totalMinutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
      totalAmount:
        sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`.mapWith(
          Number,
        ),
      memberCount: sql<number>`count(*)::int`,
    })
    .from(weeklyStaffRecords)
    .where(eq(weeklyStaffRecords.weekId, weekId));

  const [closed] = await tx
    .update(weeks)
    .set({
      status: "closed",
      closedAt: now,
      closedBy: null,
      frozenTotalMinutes: totals?.totalMinutes ?? 0,
      frozenTotalAmount: Number(totals?.totalAmount ?? 0),
      frozenMemberCount: totals?.memberCount ?? 0,
      updatedAt: now,
    })
    .where(eq(weeks.id, weekId))
    .returning();

  if (!closed) throw new Error("No se pudo cerrar el período " + weekId);

  await appendAuditLog(tx, {
    actor,
    action: "WEEK_CLOSED",
    entity: "weeks",
    entityId: closed.id,
    summary:
      "Cierre automático de " +
      formatPeriodLabel(closed.startDate, closed.endDate) +
      " — " +
      formatMinutes(closed.frozenTotalMinutes ?? 0) +
      " y " +
      formatMoney(closed.frozenTotalAmount ?? 0),
    after: {
      totalMinutos: closed.frozenTotalMinutes,
      totalImporte: closed.frozenTotalAmount,
      miembros: closed.frozenMemberCount,
    },
    reason: "Rotación automática de los sábados",
  });

  return {
    code: closed.code,
    minutes: closed.frozenTotalMinutes ?? 0,
    amount: closed.frozenTotalAmount ?? 0,
  };
}

async function openPeriod(tx: Tx, startDate: CalendarDate, endDateExplicito?: CalendarDate) {
  const actor = systemActor("Apertura automática de período");
  // La semana dura siete días salvo que haya que recortarla para no pisar otro.
  const endDate = endDateExplicito ?? addDays(startDate, PERIOD_LENGTH - 1);
  const code = buildPeriodCode(startDate, endDate);

  const [existing] = await tx.select().from(weeks).where(eq(weeks.code, code)).limit(1);
  if (existing) {
    return { code: existing.code, startDate: existing.startDate, endDate: existing.endDate };
  }

  const [created] = await tx
    .insert(weeks)
    .values({
      code,
      label: "Semana del " + startDate,
      startDate,
      endDate,
      status: "open",
      createdBy: null,
    })
    .returning();

  if (!created) throw new Error("No se pudo abrir el período " + code);

  // Todo el staff activo entra en cero, para que nadie quede fuera por olvido.
  await tx.execute(sql`
    insert into weekly_staff_records (
      week_id, staff_member_id, staff_name_snapshot, rank_snapshot, category_snapshot,
      hourly_rate_snapshot, total_minutes, calculated_amount, entry_count
    )
    select ${created.id}::uuid, s.id, s.name, s.rank, s.category, r.rate_per_hour, 0, 0, 0
    from staff_members s
    join rank_rates r on r.rank = s.rank
    where s.active = true and s.archived_at is null
    on conflict (week_id, staff_member_id) do nothing
  `);

  await appendAuditLog(tx, {
    actor,
    action: "WEEK_CREATED",
    entity: "weeks",
    entityId: created.id,
    summary: "Apertura automática de " + formatPeriodLabel(startDate, endDate),
    after: {
      codigo: created.code,
      inicio: startDate,
      fin: endDate,
      dias: periodLengthInDays(startDate, endDate),
    },
    reason: "Rotación automática de los sábados",
  });

  return { code: created.code, startDate, endDate };
}
