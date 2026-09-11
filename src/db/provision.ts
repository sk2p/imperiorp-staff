import { sql } from "drizzle-orm";

import { closeDatabase, db, withTransaction } from "@/db";
import { staffMembers, staffRankHistory, users } from "@/db/schema";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/password";
import { logger } from "@/lib/core/logger";
import { RANK_DEFINITIONS, type StaffRank } from "@/domain/ranks";
import type { UserRole } from "@/domain/permissions";
import { secretFingerprint } from "@/lib/core/fingerprint";
import { runMigrations } from "./migrate";
import { ensureRankRates, ensureSettings } from "@/server/settings";

/**
 * Puesta a punto del panel de Imperio RP.
 *
 * Borra TODO lo operativo (staff, períodos, horas, pagos, auditoría, usuarios)
 * y deja creadas únicamente las cuentas reales del equipo.
 *
 * Se conservan las tablas de referencia: tarifas por rango y configuración.
 *
 * Ejecutar con:  pnpm db:provision
 */

interface Account {
  readonly username: string;
  readonly displayName: string;
  readonly role: UserRole;
  /** Rango dentro del servidor. Si falta, no se crea ficha de staff. */
  readonly rank?: StaffRank;
}

const ACCOUNTS: readonly Account[] = [
  // pit creó el sistema: es el único rol por encima de Owner, y el único que
  // puede administrar cuentas Owner.
  { username: "pit", displayName: "Pit", role: "FOUNDER", rank: "ADM++" },

  { username: "neoblue", displayName: "NeoBlue", role: "OWNER" },
  { username: "mia", displayName: "Mia", role: "OWNER", rank: "DG" },
  { username: "h44ru", displayName: "H44ru", role: "OWNER", rank: "SUBDG" },
  { username: "mati", displayName: "Mati", role: "OWNER", rank: "ADM++" },
  { username: "xavi", displayName: "Xavi", role: "OWNER", rank: "ADM++" },
  { username: "joaquito", displayName: "Joaquito", role: "OWNER", rank: "ADM++" },
  { username: "robertito", displayName: "Robertito", role: "OWNER", rank: "ADM++" },
  { username: "rocy", displayName: "Rocy", role: "OWNER", rank: "ADM++" },
  { username: "lukita", displayName: "Lukita", role: "OWNER", rank: "ADM++" },
];

/**
 * Vacía las tablas operativas.
 *
 * `truncate … cascade` en una sola sentencia evita tener que respetar el orden
 * de las claves foráneas y es inmediato incluso con muchos registros.
 */
async function wipeOperationalData(): Promise<void> {
  await db.execute(sql`
    truncate table
      payments,
      weekly_staff_records,
      hour_entries,
      weeks,
      staff_rank_history,
      staff_members,
      audit_logs,
      security_events,
      login_attempts,
      sessions,
      import_batches,
      rank_rate_history,
      users
    restart identity cascade
  `);
}

export async function provision(): Promise<{ username: string; password: string; role: string }[]> {
  await runMigrations();

  logger.warn("Borrando todos los datos operativos…");
  await wipeOperationalData();

  // Las tarifas incluyen ahora DG y SUBDG; la configuración se recrea si falta.
  await ensureRankRates();
  await ensureSettings();

  const created: { username: string; password: string; role: string }[] = [];

  for (const account of ACCOUNTS) {
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);

    await withTransaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          username: account.username,
          displayName: account.displayName,
          passwordHash,
          role: account.role,
          // Todos entran con acceso total, como se pidió.
          mustChangePassword: false,
        })
        .returning();

      if (!user) throw new Error("No se pudo crear el usuario " + account.username);

      if (account.rank) {
        const definition = RANK_DEFINITIONS[account.rank];

        const [member] = await tx
          .insert(staffMembers)
          .values({
            name: account.displayName,
            rank: account.rank,
            category: definition.category,
            createdBy: user.id,
          })
          .returning();

        if (member) {
          await tx.insert(staffRankHistory).values({
            staffMemberId: member.id,
            fromRank: null,
            toRank: account.rank,
            changeType: "alta",
            reason: "Alta inicial del staff",
            changedBy: user.id,
            changedByUsername: user.username,
          });
        }
      }
    });

    created.push({ username: account.username, password, role: account.role });
  }

  return created;
}

const isDirectRun = process.argv[1]?.includes("provision");

if (isDirectRun) {
  provision()
    .then((accounts) => {
      const width = 78;
      const line = "═".repeat(width);

      console.log("\n" + line);
      console.log("  IMPERIO RP — CUENTAS CREADAS");
      console.log("  Guardá estas contraseñas AHORA: no se vuelven a mostrar.");
      console.log(line);
      console.log("  " + "USUARIO".padEnd(14) + "CONTRASEÑA".padEnd(20) + "ROL");
      console.log("  " + "─".repeat(width - 4));

      for (const account of accounts) {
        console.log(
          "  " + account.username.padEnd(14) + account.password.padEnd(20) + account.role,
        );
      }

      console.log(line);

      /**
       * El SESSION_SECRET es el pepper con el que se derivan estos hashes. Si
       * el servidor de producción arranca con otro distinto, NINGUNA de estas
       * contraseñas va a funcionar y el error no dice por qué.
       *
       * Se imprime una huella (no el secreto) para poder comparar de un vistazo
       * con la variable cargada en el proveedor.
       */
      console.log("  Huella del SESSION_SECRET usado: " + secretFingerprint());
      console.log("  Tiene que coincidir con la del servidor donde despliegues,");
      console.log("  o estas contraseñas no van a servir. Verificalo en /api/ready.");
      console.log(line);
      console.log("  La base quedó vacía: sin períodos, sin horas y sin pagos.");
      console.log("  Primer paso en el panel: crear el período en Períodos.\n");
    })
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error("Falló la puesta a punto", { error });
      process.exit(1);
    });
}
