import { eq, sql } from "drizzle-orm";

import { closeDatabase, db, withTransaction } from "@/db";
import {
  hourEntries,
  payments,
  staffMembers,
  staffRankHistory,
  users,
  weeklyStaffRecords,
  weeks,
} from "@/db/schema";
import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/password";
import { calculateEarnings } from "@/domain/payroll";
import { addDays, buildPeriodCode } from "@/domain/periods";
import { RANK_DEFINITIONS, type StaffRank } from "@/domain/ranks";
import { runMigrations } from "./migrate";

/**
 * Datos de arranque.
 *
 * · `bootstrap()` crea sólo lo imprescindible: el usuario OWNER inicial.
 *   Es seguro ejecutarlo en producción.
 * · `seedDemoData()` agrega staff, períodos, horas y pagos ficticios para poder
 *   recorrer la aplicación entera. NUNCA debe correrse en producción.
 */

export async function bootstrapOwner(): Promise<{ username: string; password: string | null }> {
  const env = getEnv();
  const username = env.INITIAL_ADMIN_USERNAME.toLowerCase();

  /**
   * Sólo se crea la cuenta inicial si NO HAY NINGÚN usuario.
   *
   * Comprobar por nombre sería un agujero: si el equipo ya tiene sus cuentas
   * reales y ninguna se llama como `INITIAL_ADMIN_USERNAME`, cada arranque
   * volvería a crear una cuenta con permisos totales y una contraseña que está
   * escrita en el archivo de entorno.
   */
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);

  if (anyUser) {
    logger.info("Ya existen usuarios: no se crea la cuenta inicial");
    return { username, password: null };
  }

  // Si no se define una contraseña, se genera una y se muestra UNA sola vez.
  const password = env.INITIAL_ADMIN_PASSWORD ?? generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  await db.insert(users).values({
    username,
    displayName: "Owner",
    passwordHash,
    role: "OWNER",
    mustChangePassword: env.INITIAL_ADMIN_PASSWORD === undefined,
  });

  logger.info("Usuario OWNER creado", { username });
  return { username, password: env.INITIAL_ADMIN_PASSWORD ? null : password };
}

const DEMO_STAFF: { name: string; rank: StaffRank; discord: string }[] = [
  { name: "Martin", rank: "MOD", discord: "martin_rp" },
  { name: "Lucas", rank: "SP", discord: "lucas.sp" },
  { name: "Pedro", rank: "ADM", discord: "pedro_adm" },
  { name: "Sofia", rank: "MOD++", discord: "sofia" },
  { name: "Nahuel", rank: "SDP", discord: "nahu" },
  { name: "Camila", rank: "SE", discord: "cami" },
  { name: "Tomas", rank: "ADM+", discord: "tomi" },
  { name: "Valentina", rank: "MOD+", discord: "valen" },
  { name: "Joaquin", rank: "SP", discord: "joaco" },
  { name: "Brenda", rank: "ADM++", discord: "bren" },
];

const DEMO_REASONS = [
  "Turno noche",
  "Moderación general",
  "Soporte en tickets",
  "Evento del servidor",
  "Turno tarde",
  "Refuerzo fin de semana",
];

/** Generador determinista: el seed produce siempre los mismos datos. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

export async function seedDemoData(): Promise<void> {
  const env = getEnv();
  if (env.NODE_ENV === "production") {
    throw new Error("seedDemoData() no puede ejecutarse en producción.");
  }

  const random = makeRandom(20_260_911);

  const [owner] = await db.select().from(users).limit(1);
  if (!owner) throw new Error("Ejecutá bootstrapOwner() antes del seed de demostración.");

  const [existingStaff] = await db.select({ value: sql<number>`count(*)::int` }).from(staffMembers);
  if ((existingStaff?.value ?? 0) > 0) {
    logger.info("Ya hay datos cargados: se omite el seed de demostración");
    return;
  }

  // Un segundo usuario para que la auditoría muestre más de un responsable.
  const [juan] = await db
    .insert(users)
    .values({
      username: "juan",
      displayName: "Juan",
      passwordHash: await hashPassword("Imperio2026Demo!"),
      role: "HIGH_STAFF",
    })
    .returning();

  const recorders = [
    { id: owner.id, username: owner.username },
    { id: juan?.id ?? owner.id, username: juan?.username ?? owner.username },
  ];

  await withTransaction(async (tx) => {
    const staff = await tx
      .insert(staffMembers)
      .values(
        DEMO_STAFF.map((member) => ({
          name: member.name,
          rank: member.rank,
          category: RANK_DEFINITIONS[member.rank].category,
          discordTag: member.discord,
          joinedAt: "2026-06-01",
          createdBy: owner.id,
        })),
      )
      .returning();

    await tx.insert(staffRankHistory).values(
      staff.map((member) => ({
        staffMemberId: member.id,
        fromRank: null,
        toRank: member.rank,
        changeType: "alta",
        reason: "Alta inicial en el staff",
        changedBy: owner.id,
        changedByUsername: owner.username,
      })),
    );

    // Cuatro períodos de 8 días: tres cerrados y pagados, uno abierto.
    const periodStarts = ["2026-08-11", "2026-08-19", "2026-08-27", "2026-09-04"];

    for (const [index, startDate] of periodStarts.entries()) {
      const endDate = addDays(startDate, 7);
      const isOpen = index === periodStarts.length - 1;

      const [week] = await tx
        .insert(weeks)
        .values({
          code: buildPeriodCode(startDate, endDate),
          label: "Semana " + (index + 33),
          startDate,
          endDate,
          status: "open",
          createdBy: owner.id,
        })
        .returning();

      if (!week) continue;

      for (const member of staff) {
        const definition = RANK_DEFINITIONS[member.rank as StaffRank];
        let totalMinutes = 0;
        let entryCount = 0;

        // Entre 2 y 5 turnos por persona y período.
        const shifts = 2 + Math.floor(random() * 4);
        for (let shift = 0; shift < shifts; shift += 1) {
          const minutes = 60 + Math.floor(random() * 300);
          const workDate = addDays(startDate, Math.floor(random() * 8));
          const reason = DEMO_REASONS[Math.floor(random() * DEMO_REASONS.length)] ?? "Turno";
          const recorder = recorders[Math.floor(random() * recorders.length)] ?? recorders[0];

          await tx.insert(hourEntries).values({
            staffMemberId: member.id,
            weekId: week.id,
            workDate,
            minutes,
            reason,
            recordedBy: recorder?.id ?? owner.id,
            recordedByUsername: recorder?.username ?? owner.username,
          });

          totalMinutes += minutes;
          entryCount += 1;
        }

        const rate = definition.defaultRatePerHour;
        await tx.insert(weeklyStaffRecords).values({
          weekId: week.id,
          staffMemberId: member.id,
          staffNameSnapshot: member.name,
          rankSnapshot: member.rank,
          categorySnapshot: member.category,
          hourlyRateSnapshot: rate,
          totalMinutes,
          calculatedAmount: calculateEarnings(totalMinutes, rate),
          entryCount,
          frozenAt: isOpen ? null : new Date(endDate + "T23:59:00Z"),
        });
      }

      if (isOpen) continue;

      const [totals] = await tx
        .select({
          minutes: sql<number>`coalesce(sum(${weeklyStaffRecords.totalMinutes}), 0)::int`,
          amount: sql<number>`coalesce(sum(${weeklyStaffRecords.calculatedAmount}), 0)::bigint`,
          members: sql<number>`count(*)::int`,
        })
        .from(weeklyStaffRecords)
        .where(eq(weeklyStaffRecords.weekId, week.id));

      await tx
        .update(weeks)
        .set({
          status: "closed",
          closedAt: new Date(endDate + "T23:59:00Z"),
          closedBy: owner.id,
          frozenTotalMinutes: totals?.minutes ?? 0,
          frozenTotalAmount: Number(totals?.amount ?? 0),
          frozenMemberCount: totals?.members ?? 0,
        })
        .where(eq(weeks.id, week.id));

      // Los dos primeros períodos quedan pagados; el tercero, pendiente.
      if (index >= 2) continue;

      const records = await tx
        .select()
        .from(weeklyStaffRecords)
        .where(eq(weeklyStaffRecords.weekId, week.id));

      await tx.insert(payments).values(
        records
          .filter((record) => record.calculatedAmount > 0)
          .map((record) => ({
            weekId: week.id,
            staffMemberId: record.staffMemberId,
            weeklyRecordId: record.id,
            amount: record.calculatedAmount,
            expectedAmount: record.calculatedAmount,
            paidAt: new Date(addDays(endDate, 1) + "T23:10:00Z"),
            paidBy: recorders[1]?.id ?? owner.id,
            paidByUsername: recorders[1]?.username ?? owner.username,
            method: "in_game",
            idempotencyKey: "seed-" + week.id.slice(0, 8) + "-" + record.staffMemberId.slice(0, 8),
          })),
      );
    }
  });

  logger.info("Datos de demostración cargados", {
    miembros: DEMO_STAFF.length,
    periodos: 4,
  });
}

const isDirectRun = process.argv[1]?.includes("seed");

if (isDirectRun) {
  const withDemo = !process.argv.includes("--only-bootstrap");

  runMigrations()
    .then(bootstrapOwner)
    .then(async (result) => {
      if (result.password) {
        logger.warn("CONTRASEÑA INICIAL GENERADA — guardala ahora, no se vuelve a mostrar", {
          usuario: result.username,
          contrasena: result.password,
        });
      }
      if (withDemo) await seedDemoData();
    })
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error("Falló el seed", { error });
      process.exit(1);
    });
}
