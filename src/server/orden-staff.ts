import { and, isNull, ne, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { staffMembers } from "@/db/schema";
import { groupForRank } from "@/domain/groups";
import { rankTier } from "@/domain/ranks";

/**
 * IMPERIO RP — Dónde va alguien en la lista cuando cambia de rango.
 *
 * La planilla de horas, el tablero de pagos y las fichas de staff ordenan cada
 * bloque por `display_order`, el orden que el equipo acomoda arrastrando filas.
 *
 * El problema: arrastrar reescribe esas posiciones de a uno —0, 1, 2…— y al
 * cambiar de rango se le asignaba a la persona el "escalón" fijo de su rango
 * nuevo, que va de a cien: 600 para MOD, 900 para SE. Un escalón de cientos
 * contra posiciones de a uno, y la persona terminaba abajo de todo de su
 * bloque, lejos de los de su mismo rango.
 *
 * Ahora se la ubica donde corresponde:
 *
 *   · Justo después del último de su mismo rango en el bloque.
 *   · Si nadie tiene ese rango, antes del primero de rango más bajo: ahí
 *     empieza lo que está por debajo en la jerarquía.
 *   · Si todos están por encima, al final.
 *
 * Y se renumera el bloque entero de a diez, en el orden que ya tenía: nadie más
 * cambia de lugar, y queda espacio entre posiciones. Los otros dos bloques no
 * se tocan.
 */
export async function ubicarEntreSuRango(
  tx: Transaction,
  staffMemberId: string,
  rank: string,
): Promise<void> {
  const bloque = groupForRank(rank);
  const tier = rankTier(rank);

  const resto = (
    await tx
      .select({
        id: staffMembers.id,
        rank: staffMembers.rank,
        name: staffMembers.name,
        displayOrder: staffMembers.displayOrder,
      })
      .from(staffMembers)
      .where(and(isNull(staffMembers.archivedAt), ne(staffMembers.id, staffMemberId)))
  )
    .filter((miembro) => groupForRank(miembro.rank) === bloque)
    // El mismo criterio con el que se dibuja la lista: orden manual, después
    // jerarquía, después nombre.
    .sort(
      (a, b) =>
        a.displayOrder - b.displayOrder ||
        rankTier(b.rank) - rankTier(a.rank) ||
        a.name.localeCompare(b.name, "es"),
    );

  let posicion = -1;
  for (let indice = resto.length - 1; indice >= 0; indice -= 1) {
    if (resto[indice]?.rank === rank) {
      posicion = indice + 1;
      break;
    }
  }

  if (posicion === -1) {
    const primeroMasBajo = resto.findIndex((miembro) => rankTier(miembro.rank) < tier);
    posicion = primeroMasBajo === -1 ? resto.length : primeroMasBajo;
  }

  const orden = [
    ...resto.slice(0, posicion).map((miembro) => miembro.id),
    staffMemberId,
    ...resto.slice(posicion).map((miembro) => miembro.id),
  ];

  const valores = orden
    .map((id, indice) => sql`(${id}::uuid, ${(indice + 1) * 10}::int)`)
    .reduce((acumulado, parte) => sql`${acumulado}, ${parte}`);

  await tx.execute(sql`
    update staff_members
       set display_order = nuevo.posicion
      from (values ${valores}) as nuevo(id, posicion)
     where staff_members.id = nuevo.id
  `);
}
