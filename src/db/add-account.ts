import { sql } from "drizzle-orm";

import { closeDatabase, db, withTransaction } from "@/db";
import { staffMembers, staffRankHistory, users } from "@/db/schema";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/password";
import { secretFingerprint } from "@/lib/core/fingerprint";
import { logger } from "@/lib/core/logger";
import { isUserRole, type UserRole } from "@/domain/permissions";
import { isStaffRank, RANK_DEFINITIONS, rankBaseOrder, type StaffRank } from "@/domain/ranks";

/**
 * Agrega UNA cuenta sin tocar nada de lo existente.
 *
 * A diferencia de `db:provision`, que vacía la base entera, esto sólo inserta.
 * Es la vía para sumar a alguien cuando el sistema ya está en uso.
 *
 * Uso:
 *   pnpm db:add-account <usuario> <nombre> [rango] [rol]
 *
 * Ejemplos:
 *   pnpm db:add-account raul Raul ADM+ OWNER
 *   pnpm db:add-account nico Nico SP MANAGER
 *   pnpm db:add-account auditor Auditor "" AUDITOR   ← sin ficha de staff
 *
 * La alternativa, y la preferible en el día a día, es hacerlo desde el panel
 * (Configuración → Nuevo usuario). Esa vía además deja registro en la
 * auditoría, cosa que este script no hace: es una operación directa sobre la
 * base, igual que la carga inicial.
 */

export interface AddAccountInput {
  readonly username: string;
  readonly displayName: string;
  readonly rank?: StaffRank | undefined;
  readonly role: UserRole;
}

export async function addAccount(
  input: AddAccountInput,
): Promise<{ username: string; password: string }> {
  const username = input.username.trim().toLowerCase();
  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  return withTransaction(async (tx) => {
    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${username}`)
      .limit(1);

    if (existingUser) {
      throw new Error(
        'Ya existe el usuario "' +
          username +
          '". Si querés cambiarle la contraseña, usá Configuración → Usuarios en el panel.',
      );
    }

    const [user] = await tx
      .insert(users)
      .values({
        username,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        mustChangePassword: false,
      })
      .returning();

    if (!user) throw new Error("No se pudo crear el usuario.");

    if (input.rank) {
      const definition = RANK_DEFINITIONS[input.rank];

      // El índice único ignora a los archivados, así que sólo choca con activos.
      const [duplicado] = await tx
        .select({ id: staffMembers.id })
        .from(staffMembers)
        .where(
          sql`lower(${staffMembers.name}) = ${input.displayName.toLowerCase()} and ${staffMembers.archivedAt} is null`,
        )
        .limit(1);

      if (duplicado) {
        throw new Error(
          'Ya hay un miembro activo llamado "' + input.displayName + '" en el staff.',
        );
      }

      const [member] = await tx
        .insert(staffMembers)
        .values({
          name: input.displayName,
          rank: input.rank,
          category: definition.category,
          userId: user.id,
          displayOrder: rankBaseOrder(input.rank),
          createdBy: user.id,
        })
        .returning();

      if (member) {
        await tx.insert(staffRankHistory).values({
          staffMemberId: member.id,
          fromRank: null,
          toRank: input.rank,
          changeType: "alta",
          reason: "Alta en el staff",
          changedBy: user.id,
          changedByUsername: user.username,
        });
      }
    }

    return { username, password };
  });
}

const isDirectRun = process.argv[1]?.includes("add-account");

if (isDirectRun) {
  const [, , argUsername, argDisplayName, argRank, argRole] = process.argv;

  if (!argUsername || !argDisplayName) {
    console.error("\nUso: pnpm db:add-account <usuario> <nombre> [rango] [rol]\n");
    console.error("  rango:  SDP SP SE MOD MOD+ MOD++ ADM ADM+ ADM++ SUBDG DG");
    console.error('          (dejalo vacío con "" si no lleva ficha de staff)');
    console.error("  rol:    FOUNDER OWNER HIGH_STAFF MANAGER AUDITOR  (por defecto OWNER)\n");
    process.exit(1);
  }

  const rank = argRank && argRank.length > 0 ? argRank : undefined;
  if (rank !== undefined && !isStaffRank(rank)) {
    console.error('Rango desconocido: "' + rank + '"');
    process.exit(1);
  }

  const role = argRole ?? "OWNER";
  if (!isUserRole(role)) {
    console.error('Rol desconocido: "' + role + '"');
    process.exit(1);
  }

  addAccount({ username: argUsername, displayName: argDisplayName, rank, role })
    .then((result) => {
      const line = "═".repeat(60);
      console.log("\n" + line);
      console.log("  CUENTA CREADA — guardá la contraseña ahora");
      console.log(line);
      console.log("  usuario:     " + result.username);
      console.log("  contraseña:  " + result.password);
      console.log("  rol:         " + role);
      console.log("  rango:       " + (rank ?? "sin ficha de staff"));
      console.log("  huella:      " + secretFingerprint());
      console.log(line + "\n");
    })
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error("No se pudo crear la cuenta", { error });
      console.error("\n" + (error instanceof Error ? error.message : String(error)) + "\n");
      process.exit(1);
    });
}
