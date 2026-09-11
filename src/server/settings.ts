import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { rankRateHistory, rankRates, systemSettings } from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import { notFound, validation } from "@/lib/core/errors";
import { formatMoney } from "@/domain/money";
import { RANK_LIST } from "@/domain/ranks";
import { DEFAULT_RANK_COLORS, groupForRank, type StaffGroup } from "@/domain/groups";
import type { UpdateRankRateInput, UpdateSettingInput } from "@/validation/system";
import { appendAuditLog } from "./audit";
import { recalculateAllOpenWeeks } from "./weeks";
/** Tarifas vigentes por rango. */
export async function listRankRates() {
  return db.select().from(rankRates).orderBy(asc(rankRates.rank));
}
export async function getRateMap(): Promise<Map<string, number>> {
  const rows = await listRankRates();
  return new Map(rows.map((row) => [row.rank, row.ratePerHour]));
}
export async function listRateHistory(limit = 50) {
  return db.select().from(rankRateHistory).orderBy(desc(rankRateHistory.createdAt)).limit(limit);
}
/**
 * Cambia la tarifa de un rango.
 *
 * Se recalculan sólo los períodos ABIERTOS. Los cerrados conservan su tarifa
 * congelada: una liquidación pasada no cambia de importe porque hoy se ajustó
 * un sueldo.
 */
export async function updateRankRate(
  input: UpdateRankRateInput,
  actor: ActorContext,
): Promise<void> {
  await withTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(rankRates)
      .where(eq(rankRates.rank, input.rank))
      .limit(1)
      .for("update");
    if (!existing) throw notFound("El rango");
    if (existing.ratePerHour === input.ratePerHour) {
      throw validation("La tarifa ya tiene ese valor.", {
        ratePerHour: ["Ingresá un importe distinto al actual."],
      });
    }
    await tx
      .update(rankRates)
      .set({
        ratePerHour: input.ratePerHour,
        version: existing.version + 1,
        updatedAt: new Date(),
        updatedBy: actor.id,
      })
      .where(eq(rankRates.rank, input.rank));
    await tx.insert(rankRateHistory).values({
      rank: input.rank,
      previousRate: existing.ratePerHour,
      newRate: input.ratePerHour,
      reason: input.reason,
      changedBy: actor.id,
      changedByUsername: actor.username,
    });
    const affected = await recalculateAllOpenWeeks(tx);
    await appendAuditLog(tx, {
      actor,
      action: "RATE_UPDATED",
      entity: "rank_rates",
      entityId: input.rank,
      summary:
        "Cambió la tarifa de " +
        input.rank +
        ": " +
        formatMoney(existing.ratePerHour) +
        " → " +
        formatMoney(input.ratePerHour) +
        "/h",
      before: { tarifa: existing.ratePerHour },
      after: { tarifa: input.ratePerHour },
      reason: input.reason,
      metadata: { periodosAbiertosRecalculados: affected },
    });
  });
}
/** Asegura que exista una fila de tarifa por cada rango oficial. */
export async function ensureRankRates(): Promise<void> {
  await db
    .insert(rankRates)
    .values(
      RANK_LIST.map((definition) => ({
        rank: definition.rank,
        category: definition.category,
        label: definition.name,
        ratePerHour: definition.defaultRatePerHour,
      })),
    )
    .onConflictDoNothing();
}
/* -------------------------------------------------------------------------- */
/* Configuración general                                                      */
/* -------------------------------------------------------------------------- */
export const DEFAULT_SETTINGS = [
  {
    key: "organization.name",
    value: "Imperio RP",
    valueType: "string",
    label: "Nombre de la organización",
    description: "Aparece en el encabezado y en las exportaciones.",
  },
  {
    key: "organization.timezone",
    value: "America/Argentina/Buenos_Aires",
    valueType: "string",
    label: "Zona horaria",
    description: "Se usa para mostrar fechas y horas en toda la aplicación.",
  },
  {
    key: "organization.currency_symbol",
    value: "$",
    valueType: "string",
    label: "Símbolo de moneda",
    description: "Símbolo que precede a los importes.",
  },
  {
    key: "payroll.default_period_days",
    value: "7",
    valueType: "number",
    label: "Duración por defecto del período",
    description: "Días que se proponen al crear un período nuevo.",
  },
  {
    key: "payroll.require_payment_reference",
    value: "false",
    valueType: "boolean",
    label: "Referencia obligatoria en los pagos",
    description: "Exige un comprobante o referencia al registrar cada pago.",
  },
  {
    key: "security.session_idle_hours",
    value: "12",
    valueType: "number",
    label: "Horas de inactividad antes de cerrar sesión",
    description: "Informativo: el valor efectivo se define por variable de entorno.",
  },
  {
    key: "ui.show_demo_banner",
    value: "false",
    valueType: "boolean",
    label: "Mostrar aviso de datos de demostración",
    description: "Muestra una franja indicando que los datos son de prueba.",
  },
] as const;
export async function listSettings() {
  return db.select().from(systemSettings).orderBy(asc(systemSettings.key));
}
export async function getSettingsMap(): Promise<Map<string, string>> {
  const rows = await listSettings();
  return new Map(rows.map((row) => [row.key, row.value]));
}
export async function ensureSettings(): Promise<void> {
  await db
    .insert(systemSettings)
    .values(DEFAULT_SETTINGS.map((setting) => ({ ...setting })))
    .onConflictDoNothing();
}
export async function updateSetting(input: UpdateSettingInput, actor: ActorContext): Promise<void> {
  await withTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, input.key))
      .limit(1);
    if (!existing) throw notFound("La configuración");
    if (existing.valueType === "number" && !/^\d+$/.test(input.value)) {
      throw validation("El valor debe ser un número entero.", { value: ["Ingresá sólo dígitos."] });
    }
    if (existing.valueType === "boolean" && !["true", "false"].includes(input.value)) {
      throw validation("El valor debe ser verdadero o falso.", { value: ["Valor inválido."] });
    }
    await tx
      .update(systemSettings)
      .set({ value: input.value, updatedAt: new Date(), updatedBy: actor.id })
      .where(eq(systemSettings.key, input.key));
    await appendAuditLog(tx, {
      actor,
      action: "SETTING_UPDATED",
      entity: "system_settings",
      entityId: input.key,
      summary: 'Cambió "' + existing.label + '" a "' + input.value + '"',
      before: { valor: existing.value },
      after: { valor: input.value },
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Tarifas por grupo y colores                                                */
/* -------------------------------------------------------------------------- */

/**
 * Aplica una tarifa a todos los rangos de un grupo.
 *
 * La planilla muestra una tarifa por familia (High / Mid / Low), así que
 * editarla debe mover los tres rangos de esa familia a la vez. Guardar cada
 * rango por separado terminaría con un MOD+ cobrando distinto que un MOD sin
 * que nadie se diera cuenta.
 */
export async function updateGroupRates(
  rates: Readonly<Record<StaffGroup, number>>,
  actor: ActorContext,
): Promise<number> {
  return withTransaction(async (tx) => {
    const current = await tx.select().from(rankRates).for("update");
    let changed = 0;

    for (const rate of current) {
      const group = groupForRank(rate.rank);
      const nuevo = rates[group];
      if (nuevo === undefined || nuevo === rate.ratePerHour) continue;

      await tx
        .update(rankRates)
        .set({
          ratePerHour: nuevo,
          version: rate.version + 1,
          updatedAt: new Date(),
          updatedBy: actor.id,
        })
        .where(eq(rankRates.rank, rate.rank));

      await tx.insert(rankRateHistory).values({
        rank: rate.rank,
        previousRate: rate.ratePerHour,
        newRate: nuevo,
        reason: "Cambio de tarifa por grupo desde Configuración",
        changedBy: actor.id,
        changedByUsername: actor.username,
      });

      changed += 1;
    }

    if (changed === 0) return 0;

    // Sólo se recalculan los períodos ABIERTOS: los cerrados conservan la
    // tarifa que tenían congelada.
    const affected = await recalculateAllOpenWeeks(tx);

    await appendAuditLog(tx, {
      actor,
      action: "RATE_UPDATED",
      entity: "rank_rates",
      entityId: "grupos",
      summary: "Actualizó las tarifas por grupo (" + changed + " rangos afectados)",
      after: {
        low: formatMoney(rates.LOW_STAFF),
        mid: formatMoney(rates.MID_STAFF),
        high: formatMoney(rates.HIGH_STAFF),
      },
      metadata: { rangosAfectados: changed, periodosRecalculados: affected },
    });

    return changed;
  });
}

/** Colores de las etiquetas de rango en la planilla. */
export async function updateRankColors(
  colors: readonly { readonly rank: string; readonly color: string }[],
  actor: ActorContext,
): Promise<number> {
  return withTransaction(async (tx) => {
    let changed = 0;

    for (const entry of colors) {
      const [updated] = await tx
        .update(rankRates)
        .set({ color: entry.color, updatedAt: new Date(), updatedBy: actor.id })
        .where(and(eq(rankRates.rank, entry.rank), ne(rankRates.color, entry.color)))
        .returning({ rank: rankRates.rank });

      if (updated) changed += 1;
    }

    if (changed === 0) return 0;

    await appendAuditLog(tx, {
      actor,
      action: "SETTING_UPDATED",
      entity: "rank_rates",
      entityId: "colores",
      summary: "Cambió los colores de " + changed + " rango(s)",
      after: Object.fromEntries(colors.map((c) => [c.rank, c.color])),
    });

    return changed;
  });
}

/** Tarifa vigente de cada grupo, tomada del primer rango de la familia. */
export async function getGroupRates(): Promise<Record<StaffGroup, number>> {
  const rates = await listRankRates();
  const result: Record<StaffGroup, number> = {
    HIGH_STAFF: 2_000_000,
    MID_STAFF: 1_500_000,
    LOW_STAFF: 1_000_000,
  };

  for (const rate of rates) {
    result[groupForRank(rate.rank)] = rate.ratePerHour;
  }

  return result;
}

/** Asigna los colores por defecto a los rangos que todavía no tienen uno propio. */
export async function ensureRankColors(): Promise<void> {
  for (const [rank, color] of Object.entries(DEFAULT_RANK_COLORS)) {
    await db
      .update(rankRates)
      .set({ color })
      .where(and(eq(rankRates.rank, rank), eq(rankRates.color, "#6f747d")));
  }
}
