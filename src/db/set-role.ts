import { sql } from "drizzle-orm";

import { closeDatabase, withTransaction } from "@/db";
import { users } from "@/db/schema";
import { logger } from "@/lib/core/logger";
import { isUserRole, roleLabel, type UserRole } from "@/domain/permissions";

/**
 * Cambia el rol de una cuenta existente.
 *
 * Desde el panel nadie puede ascender a alguien a su propio nivel —es la
 * defensa contra la escalada de privilegios—, así que nombrar a un segundo
 * Fundador tiene que hacerse desde acá, con acceso a la base.
 *
 * Uso:
 *   pnpm db:set-role <usuario> <rol>
 *
 * Ejemplo:
 *   pnpm db:set-role mati FOUNDER
 */
export async function setRole(username: string, role: UserRole): Promise<{ previous: string }> {
  const target = username.trim().toLowerCase();

  return withTransaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, role: users.role, version: users.version })
      .from(users)
      .where(sql`lower(${users.username}) = ${target}`)
      .limit(1);

    if (!user) throw new Error('No existe el usuario "' + target + '".');
    if (user.role === role) throw new Error(target + " ya es " + roleLabel(role) + ".");

    await tx
      .update(users)
      .set({ role, version: user.version + 1, updatedAt: new Date() })
      .where(sql`${users.id} = ${user.id}`);

    return { previous: user.role };
  });
}

const isDirectRun = process.argv[1]?.includes("set-role");

if (isDirectRun) {
  const [, , argUsername, argRole] = process.argv;

  if (!argUsername || !argRole) {
    console.error("\nUso: pnpm db:set-role <usuario> <rol>");
    console.error("  rol: FOUNDER OWNER HIGH_STAFF MANAGER AUDITOR\n");
    process.exit(1);
  }

  if (!isUserRole(argRole)) {
    console.error('Rol desconocido: "' + argRole + '"');
    process.exit(1);
  }

  setRole(argUsername, argRole)
    .then((result) => {
      console.log(
        "\n  " +
          argUsername +
          ": " +
          roleLabel(result.previous) +
          " → " +
          roleLabel(argRole) +
          "\n",
      );
    })
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error("No se pudo cambiar el rol", { error });
      console.error("\n" + (error instanceof Error ? error.message : String(error)) + "\n");
      process.exit(1);
    });
}
