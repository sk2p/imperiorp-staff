import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";
import { runMigrations } from "@/db/migrate";
import { hourEntries, staffMembers, users, weeklyStaffRecords, weeks } from "@/db/schema";
import { buildPeriodCode } from "@/domain/periods";
import { RANK_DEFINITIONS } from "@/domain/ranks";
import { resumirRachas } from "@/domain/rachas";
import { rachasYRecords } from "@/server/shifts";

/**
 * Rachas y récords de `/top`.
 *
 * La regla de "racha viva" se prueba sola, y la consulta contra una base de
 * verdad: arma los tramos de días seguidos con aritmética de fechas y funciones
 * de ventana, que es exactamente la clase de SQL que falla sin que ningún test
 * de lógica pura lo vea.
 */

const HOY = "2026-09-13";

describe("la racha viva", () => {
  it("sigue viva si terminó hoy o ayer, y la mejor es el tramo más largo", () => {
    const rachas = resumirRachas(
      [
        { staffMemberId: "ana", dias: 5, hasta: "2026-08-05" },
        { staffMemberId: "ana", dias: 3, hasta: HOY },
        { staffMemberId: "bruno", dias: 2, hasta: "2026-09-12" },
        { staffMemberId: "carla", dias: 4, hasta: "2026-09-11" },
      ],
      HOY,
    );

    expect(rachas.get("ana")).toEqual({ actual: 3, mejor: 5 });
    // Todavía no fichó hoy, pero ayer sí: la racha no se corta a la mañana.
    expect(rachas.get("bruno")).toEqual({ actual: 2, mejor: 2 });
    // Antes de ayer: cortada.
    expect(rachas.get("carla")).toEqual({ actual: 0, mejor: 4 });
  });

  it("sin días, sin rachas", () => {
    expect(resumirRachas([], HOY).size).toBe(0);
  });
});

describe("la consulta de rachas y récords", () => {
  const ids = { ana: "", bruno: "", carla: "" };

  beforeAll(async () => {
    await runMigrations();

    const [usuario] = await db
      .insert(users)
      .values({ username: "prueba", passwordHash: "x", role: "OWNER" })
      .returning();

    const semana = async (inicio: string, fin: string, cerrada: boolean) => {
      const [fila] = await db
        .insert(weeks)
        .values({
          code: buildPeriodCode(inicio, fin),
          startDate: inicio,
          endDate: fin,
          status: cerrada ? "closed" : "open",
          ...(cerrada
            ? {
                closedAt: new Date(),
                closedBy: usuario!.id,
                frozenTotalMinutes: 0,
                frozenTotalAmount: 0,
                frozenMemberCount: 0,
              }
            : {}),
        })
        .returning();
      return fila!.id;
    };

    const ficha = async (name: string, rank: "ADM" | "MOD" | "SP", archivada = false) => {
      const [fila] = await db
        .insert(staffMembers)
        .values({
          name,
          rank,
          category: RANK_DEFINITIONS[rank].category,
          joinedAt: "2026-06-01",
          ...(archivada ? { archivedAt: new Date() } : {}),
        })
        .returning();
      return fila!.id;
    };

    const dias = async (
      staffMemberId: string,
      weekId: string,
      fechas: readonly string[],
      extra: { status?: string; voidedAt?: Date } = {},
    ) => {
      await db.insert(hourEntries).values(
        fechas.map((workDate) => ({
          staffMemberId,
          weekId,
          workDate,
          minutes: 60,
          seconds: 3600,
          recordedByUsername: "prueba",
          ...extra,
        })),
      );
    };

    const registro = async (
      weekId: string,
      staffMemberId: string,
      name: string,
      rank: "ADM" | "MOD" | "SP",
      totalMinutes: number,
    ) => {
      await db.insert(weeklyStaffRecords).values({
        weekId,
        staffMemberId,
        staffNameSnapshot: name,
        rankSnapshot: rank,
        categorySnapshot: RANK_DEFINITIONS[rank].category,
        hourlyRateSnapshot: 1000,
        totalMinutes,
        calculatedAmount: totalMinutes * 10,
        entryCount: 1,
      });
    };

    const agosto = await semana("2026-08-01", "2026-08-07", true);
    const anterior = await semana("2026-09-05", "2026-09-11", true);
    const actual = await semana("2026-09-12", "2026-09-18", false);

    ids.ana = await ficha("Ana", "ADM");
    ids.bruno = await ficha("Bruno", "MOD");
    ids.carla = await ficha("Carla", "SP", true);

    // Ana: cinco días en agosto, y una racha viva que cruza de un período al otro.
    await dias(ids.ana, agosto, [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
    ]);
    await dias(ids.ana, anterior, ["2026-09-11"]);
    // El 14 está cargado por adelantado: no cuenta todavía.
    await dias(ids.ana, actual, ["2026-09-12", HOY, "2026-09-14"]);

    // Bruno: dos días, y después uno anulado y uno inactivo, que no suman.
    await dias(ids.bruno, anterior, ["2026-09-10", "2026-09-11"]);
    await dias(ids.bruno, actual, ["2026-09-12"], { voidedAt: new Date() });
    await dias(ids.bruno, actual, [HOY], { status: "inactivo" });

    // Carla: la racha más larga de todas, pero ya no está en el staff.
    await dias(ids.carla, agosto, [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
    ]);

    await registro(agosto, ids.ana, "Ana", "ADM", 1200);
    await registro(agosto, ids.carla, "Carla", "SP", 3000);
    await registro(anterior, ids.ana, "Ana", "ADM", 900);
    await registro(anterior, ids.bruno, "Bruno", "MOD", 2500);
    // El período abierto no cuenta para récords, por más horas que tenga.
    await registro(actual, ids.bruno, "Bruno", "MOD", 5000);
  }, 60_000);

  it("cuenta días seguidos aunque crucen de un período a otro, sin anulados ni inactivos", async () => {
    const resultado = await rachasYRecords(HOY);

    expect(resultado.porMiembro.get(ids.ana)).toEqual({
      rachaActual: 3,
      mejorRacha: 5,
      mejorPeriodo: 1200,
    });
    expect(resultado.porMiembro.get(ids.bruno)).toEqual({
      rachaActual: 0,
      mejorRacha: 2,
      mejorPeriodo: 2500,
    });
  });

  it("destaca sólo a quien sigue en el staff", async () => {
    const resultado = await rachasYRecords(HOY);

    expect(resultado.rachaEnCurso).toEqual({ name: "Ana", rank: "ADM", dias: 3 });
    expect(resultado.mejorRacha).toEqual({ name: "Ana", rank: "ADM", dias: 5 });
  });

  it("el récord de período sale de los cerrados, con el nombre de ese momento", async () => {
    const resultado = await rachasYRecords(HOY);

    expect(resultado.recordPeriodo).toEqual({
      name: "Carla",
      rank: "SP",
      minutes: 3000,
      startDate: "2026-08-01",
      endDate: "2026-08-07",
    });
  });
});
