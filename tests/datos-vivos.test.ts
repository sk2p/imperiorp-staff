import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db, withTransaction } from "@/db";
import { runMigrations } from "@/db/migrate";
import {
  hourEntries,
  payments,
  shiftSessions,
  staffMembers,
  users,
  weeklyStaffRecords,
  weeks,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { buildPeriodCode } from "@/domain/periods";
import { RANK_DEFINITIONS } from "@/domain/ranks";
import { appendAuditLog } from "@/server/audit";
import { firmaDeDatos } from "@/server/firma";
import { paymentHistory } from "@/server/shifts";

/**
 * Contra una base de verdad —PGlite en memoria, con todas las migraciones—,
 * no contra funciones sueltas.
 *
 * Las dos cosas que se prueban acá son consultas escritas a mano, y las
 * consultas a mano fallan de formas que ningún test de lógica pura ve: una
 * columna mal calificada, una fecha que llega corrida de huso, un pago anulado
 * que se cuela como vigente. Si alguna de esas pasa, la pantalla no se refresca
 * o el bot le dice a alguien que cobró cuando no.
 */

let userId = "";
let staffId = "";

beforeAll(async () => {
  await runMigrations();

  const [usuario] = await db
    .insert(users)
    .values({
      username: "prueba",
      displayName: "Prueba",
      passwordHash: await hashPassword("Prueba-Imperio-2026!"),
      role: "OWNER",
    })
    .returning();
  userId = usuario!.id;

  const [ficha] = await db
    .insert(staffMembers)
    .values({
      name: "Martin",
      rank: "MOD",
      category: RANK_DEFINITIONS.MOD.category,
      joinedAt: "2026-06-01",
      createdBy: userId,
    })
    .returning();
  staffId = ficha!.id;
  // Correr todas las migraciones sobre una base nueva tarda varios segundos, y
  // con la máquina ocupada pasa los diez que vitest le da a un gancho.
}, 60_000);

async function nuevaSemana(inicio: string, fin: string, cerrada: boolean) {
  const [semana] = await db
    .insert(weeks)
    .values({
      code: buildPeriodCode(inicio, fin),
      label: "Semana de prueba",
      startDate: inicio,
      endDate: fin,
      status: cerrada ? "closed" : "open",
      createdBy: userId,
      // Un período cerrado lleva sus totales congelados: la base lo exige
      // (`weeks_closed_has_snapshot`) y es justo lo que hace confiable al cierre.
      ...(cerrada
        ? {
            closedAt: new Date(),
            closedBy: userId,
            frozenTotalMinutes: 0,
            frozenTotalAmount: 0,
            frozenMemberCount: 0,
          }
        : {}),
    })
    .returning();
  return semana!;
}

async function nuevaFila(weekId: string, minutos: number, importe: number) {
  const [fila] = await db
    .insert(weeklyStaffRecords)
    .values({
      weekId,
      staffMemberId: staffId,
      staffNameSnapshot: "Martin",
      rankSnapshot: "MOD",
      categorySnapshot: RANK_DEFINITIONS.MOD.category,
      hourlyRateSnapshot: 1000,
      totalMinutes: minutos,
      calculatedAmount: importe,
      entryCount: 1,
    })
    .returning();
  return fila!;
}

describe("la firma de los datos", () => {
  it("sin cambios, da siempre lo mismo", async () => {
    expect(await firmaDeDatos()).toBe(await firmaDeDatos());
  });

  it("cambia al abrir un fichaje y otra vez al cerrarlo", async () => {
    const antes = await firmaDeDatos();

    const [sesion] = await db
      .insert(shiftSessions)
      .values({ staffMemberId: staffId, startedAt: new Date(), startDate: "2026-09-13" })
      .returning();

    const abierta = await firmaDeDatos();
    expect(abierta).not.toBe(antes);

    await db
      .update(shiftSessions)
      .set({ endedAt: new Date(), seconds: 60 })
      .where(eq(shiftSessions.id, sesion!.id));

    expect(await firmaDeDatos()).not.toBe(abierta);
  });

  it("cambia con cada registro de auditoría", async () => {
    const antes = await firmaDeDatos();

    await withTransaction((tx) =>
      appendAuditLog(tx, {
        actor: {
          id: userId,
          username: "prueba",
          role: "OWNER",
          ip: undefined,
          userAgent: undefined,
          traceId: "prueba",
          sessionId: "prueba",
        },
        action: "PAYMENT_CREATED",
        entity: "payments",
        entityId: "prueba",
        summary: "Registro de prueba",
      }),
    );

    expect(await firmaDeDatos()).not.toBe(antes);
  });

  it("cambia cuando se abre un período", async () => {
    const antes = await firmaDeDatos();
    await nuevaSemana("2026-10-03", "2026-10-09", false);
    expect(await firmaDeDatos()).not.toBe(antes);
  });

  /**
   * Los casos que la primera versión no veía: cambios que no pasan por la
   * auditoría ni tocan los fichajes. Sumar a alguien a la planilla del período
   * abierto es uno real; editar una fila a mano en la consola de la base, otro.
   */
  it("cambia al modificar una fila aunque nadie deje registro", async () => {
    const antes = await firmaDeDatos();

    await db.update(staffMembers).set({ name: "Martín" }).where(eq(staffMembers.id, staffId));

    expect(await firmaDeDatos()).not.toBe(antes);
  });

  it("cambia al cargar horas sin auditoría", async () => {
    const semana = await nuevaSemana("2026-10-10", "2026-10-16", false);
    const antes = await firmaDeDatos();

    await db.insert(hourEntries).values({
      staffMemberId: staffId,
      weekId: semana.id,
      workDate: "2026-10-11",
      minutes: 90,
      reason: "Prueba",
      recordedBy: userId,
      recordedByUsername: "prueba",
    });

    expect(await firmaDeDatos()).not.toBe(antes);
  });
});

describe("/mis-pagos", () => {
  it("lista los períodos cerrados con horas, del más nuevo al más viejo, con su estado", async () => {
    // Pagada.
    const pagada = await nuevaSemana("2026-08-22", "2026-08-28", true);
    const filaPagada = await nuevaFila(pagada.id, 600, 10_000);
    await db.insert(payments).values({
      weekId: pagada.id,
      staffMemberId: staffId,
      weeklyRecordId: filaPagada.id,
      amount: 10_000,
      expectedAmount: 10_000,
      paidAt: new Date("2026-08-29T23:10:00Z"),
      paidBy: userId,
      paidByUsername: "prueba",
      method: "in_game",
      idempotencyKey: "prueba-pagada",
    });

    // Con el pago anulado: para quien pregunta, no está pagada.
    const anulada = await nuevaSemana("2026-08-29", "2026-09-04", true);
    const filaAnulada = await nuevaFila(anulada.id, 300, 5_000);
    await db.insert(payments).values({
      weekId: anulada.id,
      staffMemberId: staffId,
      weeklyRecordId: filaAnulada.id,
      amount: 5_000,
      expectedAmount: 5_000,
      paidAt: new Date("2026-09-05T20:00:00Z"),
      paidBy: userId,
      paidByUsername: "prueba",
      method: "in_game",
      idempotencyKey: "prueba-anulada",
      voidedAt: new Date("2026-09-05T21:00:00Z"),
      voidReason: "Se cargó dos veces",
    });

    // Abierta: todavía no es un pago que se pueda reclamar.
    const abierta = await nuevaSemana("2026-09-05", "2026-09-11", false);
    await nuevaFila(abierta.id, 120, 2_000);

    // Cerrada pero sin horas: no hay nada que cobrar, no se lista.
    const vacia = await nuevaSemana("2026-08-15", "2026-08-21", true);
    await nuevaFila(vacia.id, 0, 0);

    const lineas = await paymentHistory(staffId);

    expect(lineas.map((linea) => linea.startDate)).toEqual(["2026-08-29", "2026-08-22"]);

    expect(lineas[0]).toMatchObject({
      endDate: "2026-09-04",
      totalMinutes: 300,
      amount: 5_000,
      paidAmount: null,
      paidAt: null,
    });

    expect(lineas[1]).toMatchObject({ endDate: "2026-08-28", amount: 10_000, paidAmount: 10_000 });
    expect(lineas[1]?.paidAt?.toISOString()).toBe("2026-08-29T23:10:00.000Z");
  });
});
