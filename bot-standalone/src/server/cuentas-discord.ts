import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "@/db";
import { staffMembers, users } from "@/db/schema";

/**
 * IMPERIO RP — A qué Discord se le escribe por una cuenta del panel.
 *
 * Una cuenta del panel no tiene Discord propio: lo tiene su ficha de staff,
 * vinculada con `/vincular`. El puente es `staff_members.user_id`. Sin ficha
 * vinculada a la cuenta, o sin Discord en la ficha, no hay a quién escribirle.
 *
 * Vive aparte y sin nada de Next porque lo usan los dos lados: la página, para
 * el aviso de acceso nuevo, y el bot, para avisar a los fundadores si la página
 * se cae.
 */

/** El Discord de la ficha vinculada a esa cuenta, si lo hay. */
export async function discordDeCuenta(userId: string): Promise<string | null> {
  const [fila] = await db
    .select({ discordUserId: staffMembers.discordUserId })
    .from(staffMembers)
    .where(
      and(
        eq(staffMembers.userId, userId),
        isNull(staffMembers.archivedAt),
        isNotNull(staffMembers.discordUserId),
      ),
    )
    .limit(1);

  return fila?.discordUserId ?? null;
}

/** Los Discord de los fundadores activos que tienen ficha vinculada. */
export async function discordDeFundadores(): Promise<readonly string[]> {
  const filas = await db
    .select({ discordUserId: staffMembers.discordUserId })
    .from(users)
    .innerJoin(staffMembers, eq(staffMembers.userId, users.id))
    .where(
      and(
        eq(users.role, "FOUNDER"),
        eq(users.active, true),
        isNull(staffMembers.archivedAt),
        isNotNull(staffMembers.discordUserId),
      ),
    );

  return [...new Set(filas.map((fila) => fila.discordUserId).filter((id) => id !== null))];
}
