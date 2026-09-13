import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db, withTransaction } from "@/db";
import { runMigrations } from "@/db/migrate";
import { staffMembers, users } from "@/db/schema";
import { groupForRank, type StaffGroup } from "@/domain/groups";
import { RANK_DEFINITIONS, type StaffRank } from "@/domain/ranks";
import { hashPassword } from "@/lib/auth/password";
import { ubicarEntreSuRango } from "@/server/orden-staff";

/**
 * Cambiar a alguien de rango lo ubica entre los de su rango.
 *
 * El error que motivó esto: en la planilla de horas, al ascender a alguien, la
 * persona aparecía abajo de todo de su categoría. El equipo ya había acomodado
 * la lista arrastrando —posiciones de a uno— y el cambio de rango le asignaba
 * un escalón fijo de a cien. Estos casos arman justo esa situación.
 */

let userId = "";

beforeAll(async () => {
  await runMigrations();

  const [usuario] = await db
    .insert(users)
    .values({
      username: "orden",
      displayName: "Orden",
      passwordHash: await hashPassword("Prueba-Orden-2026!"),
      role: "OWNER",
    })
    .returning();
  userId = usuario!.id;
  // Correr todas las migraciones sobre una base nueva tarda varios segundos, y
  // con la máquina ocupada pasa los diez que vitest le da a un gancho.
}, 60_000);

async function alta(name: string, rank: StaffRank, displayOrder: number): Promise<string> {
  const [ficha] = await db
    .insert(staffMembers)
    .values({
      name,
      rank,
      category: RANK_DEFINITIONS[rank].category,
      joinedAt: "2026-06-01",
      createdBy: userId,
      displayOrder,
    })
    .returning();
  return ficha!.id;
}

/** Lo mismo que hace el cambio de rango: rango nuevo, y ubicarlo. */
async function cambiarRango(id: string, rank: StaffRank): Promise<void> {
  await withTransaction(async (tx) => {
    await tx
      .update(staffMembers)
      .set({ rank, category: RANK_DEFINITIONS[rank].category })
      .where(eq(staffMembers.id, id));
    await ubicarEntreSuRango(tx, id, rank);
  });
}

async function bloque(grupo: StaffGroup): Promise<string[]> {
  const filas = await db
    .select({ name: staffMembers.name, rank: staffMembers.rank })
    .from(staffMembers)
    .orderBy(asc(staffMembers.displayOrder));
  return filas.filter((fila) => groupForRank(fila.rank) === grupo).map((fila) => fila.name);
}

describe("cambiar de rango", () => {
  it("un ascenso queda junto a los de su rango nuevo, no al final del bloque", async () => {
    // Bloque Mid ya acomodado a mano, con posiciones de a uno.
    await alta("Sofia", "MOD++", 0);
    await alta("Valentina", "MOD+", 1);
    await alta("Lucia", "MOD+", 2);
    await alta("Martin", "MOD", 3);
    await alta("Bruno", "MOD", 4);
    const camila = await alta("Camila", "SE", 0);

    await cambiarRango(camila, "MOD+");

    expect(await bloque("MID_STAFF")).toEqual([
      "Sofia",
      "Valentina",
      "Lucia",
      "Camila",
      "Martin",
      "Bruno",
    ]);
  });

  it("si nadie tiene ese rango, va antes del primero de rango más bajo", async () => {
    await alta("Pedro", "ADM+", 0);
    await alta("Tomas", "ADM", 1);
    await alta("Brenda", "ADM", 2);
    const joaquin = await alta("Joaquin", "SP", 0);

    // Nadie es ADM++: queda arriba de Pedro, que es ADM+.
    await cambiarRango(joaquin, "ADM++");

    expect(await bloque("HIGH_STAFF")).toEqual(["Joaquin", "Pedro", "Tomas", "Brenda"]);
  });

  it("un descenso también queda con los de su rango, y el resto no se mueve", async () => {
    const tomas = (await db.select().from(staffMembers).where(eq(staffMembers.name, "Tomas")))[0]!;

    // Tomas baja de ADM a MOD: va después de Bruno, el último MOD.
    await cambiarRango(tomas.id, "MOD");

    expect(await bloque("MID_STAFF")).toEqual([
      "Sofia",
      "Valentina",
      "Lucia",
      "Camila",
      "Martin",
      "Bruno",
      "Tomas",
    ]);
    expect(await bloque("HIGH_STAFF")).toEqual(["Joaquin", "Pedro", "Brenda"]);
  });
});
