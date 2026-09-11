import { and, asc, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, withTransaction, type Transaction } from "@/db";
import { users, type User } from "@/db/schema";
import type { ActorContext } from "@/lib/auth/context";
import {
  businessRule,
  concurrency,
  conflict,
  forbidden,
  notFound,
  validation,
} from "@/lib/core/errors";
import { canManageRole, roleLabel } from "@/domain/permissions";
import {
  evaluatePassword,
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from "@/lib/auth/password";
import { revokeAllUserSessions } from "@/lib/auth/session";
import { containsPattern, offsetFor, paginate, type Paginated } from "@/validation/common";
import type {
  ChangeOwnPasswordInput,
  CreateUserInput,
  ResetUserPasswordInput,
  UpdateUserInput,
  UserFilters,
} from "@/validation/users";
import { appendAuditLog } from "./audit";
import { recordSecurityEvent } from "./security-events";
/** Vista de usuario sin hash ni campos internos. */
export interface UserView {
  readonly id: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly role: string;
  readonly grantedPermissions: string[];
  readonly revokedPermissions: string[];
  readonly active: boolean;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: Date | null;
  readonly lastLoginIp: string | null;
  readonly lockedUntil: Date | null;
  readonly version: number;
  readonly createdAt: Date;
}
const userSelect = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  grantedPermissions: users.grantedPermissions,
  revokedPermissions: users.revokedPermissions,
  active: users.active,
  mustChangePassword: users.mustChangePassword,
  lastLoginAt: users.lastLoginAt,
  lastLoginIp: users.lastLoginIp,
  lockedUntil: users.lockedUntil,
  version: users.version,
  createdAt: users.createdAt,
} as const;
export async function listUsers(filters: UserFilters): Promise<Paginated<UserView>> {
  const conditions: SQL[] = [];
  if (filters.role) conditions.push(eq(users.role, filters.role));
  if (filters.status === "active") conditions.push(eq(users.active, true));
  if (filters.status === "inactive") conditions.push(eq(users.active, false));
  if (filters.search) {
    const pattern = containsPattern(filters.search);
    const matches = or(
      sql`${users.username} ilike ${pattern}`,
      sql`${users.displayName} ilike ${pattern}`,
    );
    if (matches) conditions.push(matches);
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [items, [countRow]] = await Promise.all([
    db
      .select(userSelect)
      .from(users)
      .where(where)
      .orderBy(asc(users.username))
      .limit(filters.pageSize)
      .offset(offsetFor(filters)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(users)
      .where(where),
  ]);
  return paginate(items, countRow?.value ?? 0, filters);
}
export async function getUserView(id: string): Promise<UserView | null> {
  const [user] = await db.select(userSelect).from(users).where(eq(users.id, id)).limit(1);
  return user ?? null;
}
/** Impide que alguien administre a un usuario de jerarquía igual o mayor. */
function assertCanManage(actorRole: string, targetRole: string, targetUsername: string): void {
  if (!canManageRole(actorRole, targetRole)) {
    throw forbidden(
      "No podés administrar a " +
        targetUsername +
        ": su rol (" +
        roleLabel(targetRole) +
        ") es igual o superior al tuyo.",
    );
  }
}
export async function createUser(input: CreateUserInput, actor: ActorContext): Promise<UserView> {
  assertCanManage(actor.role, input.role, input.username);
  const strength = evaluatePassword(input.password, input.username);
  if (!strength.valid) {
    throw validation("La contraseña no cumple los requisitos.", {
      password: [...strength.problems],
    });
  }
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${input.username}`)
      .limit(1);
    if (existing) throw conflict('Ya existe un usuario "' + input.username + '".');
    const [created] = await tx
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        grantedPermissions: [...input.grantedPermissions],
        revokedPermissions: [...input.revokedPermissions],
        mustChangePassword: input.mustChangePassword,
        createdBy: actor.id,
      })
      .returning(userSelect);
    if (!created) throw new Error("No se pudo crear el usuario.");
    await appendAuditLog(tx, {
      actor,
      action: "USER_CREATED",
      entity: "users",
      entityId: created.id,
      summary: "Creó el usuario " + created.username + " (" + roleLabel(created.role) + ")",
      after: {
        usuario: created.username,
        rol: created.role,
        permisosExtra: created.grantedPermissions,
      },
    });
    return created;
  });
}
export async function updateUser(input: UpdateUserInput, actor: ActorContext): Promise<UserView> {
  return withTransaction(async (tx) => {
    const existing = await lockUser(tx, input.id);
    assertCanManage(actor.role, existing.role, existing.username);
    assertCanManage(actor.role, input.role, existing.username);
    // Nadie puede desactivarse ni degradarse a sí mismo: dejaría el sistema sin
    // acceso si es el único con ese rol.
    if (existing.id === actor.id && (!input.active || input.role !== existing.role)) {
      throw businessRule("No podés cambiar tu propio rol ni desactivar tu cuenta.");
    }
    if (existing.role === "OWNER" && input.role !== "OWNER") {
      const [owners] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.role, "OWNER"), eq(users.active, true)));
      if ((owners?.value ?? 0) <= 1) {
        throw businessRule("Es el único Owner activo. Designá otro antes de cambiarle el rol.");
      }
    }
    const [updated] = await tx
      .update(users)
      .set({
        displayName: input.displayName,
        role: input.role,
        grantedPermissions: [...input.grantedPermissions],
        revokedPermissions: [...input.revokedPermissions],
        active: input.active,
        ...(input.active ? {} : { deactivatedAt: new Date(), deactivatedBy: actor.id }),
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, input.id), eq(users.version, input.expectedVersion)))
      .returning(userSelect);
    if (!updated) throw concurrency();
    // Una cuenta desactivada pierde sus sesiones en el acto.
    if (existing.active && !updated.active) {
      await revokeAllUserSessions(updated.id, "Cuenta desactivada", { revokedBy: actor.id }, tx);
      await recordSecurityEvent(
        {
          type: "ACCOUNT_DEACTIVATED",
          userId: updated.id,
          username: updated.username,
          ip: actor.ip,
        },
        tx,
      );
    }
    await appendAuditLog(tx, {
      actor,
      action: "USER_UPDATED",
      entity: "users",
      entityId: updated.id,
      summary: "Editó el usuario " + updated.username,
      before: {
        rol: existing.role,
        activo: existing.active,
        permisosExtra: existing.grantedPermissions,
      },
      after: {
        rol: updated.role,
        activo: updated.active,
        permisosExtra: updated.grantedPermissions,
      },
      reason: input.reason,
    });
    return updated;
  });
}
export async function resetUserPassword(
  input: ResetUserPasswordInput,
  actor: ActorContext,
): Promise<{ username: string; temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  return withTransaction(async (tx) => {
    const existing = await lockUser(tx, input.id);
    assertCanManage(actor.role, existing.role, existing.username);
    await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: true,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        version: existing.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.id));
    if (input.revokeSessions) {
      await revokeAllUserSessions(
        existing.id,
        "Contraseña restablecida",
        { revokedBy: actor.id },
        tx,
      );
    }
    await recordSecurityEvent(
      { type: "PASSWORD_RESET", userId: existing.id, username: existing.username, ip: actor.ip },
      tx,
    );
    await appendAuditLog(tx, {
      actor,
      action: "USER_PASSWORD_RESET",
      entity: "users",
      entityId: existing.id,
      summary: "Restableció la contraseña de " + existing.username,
      reason: input.reason,
      metadata: { sesionesRevocadas: input.revokeSessions },
    });
    return { username: existing.username, temporaryPassword };
  });
}
export async function changeOwnPassword(
  input: ChangeOwnPasswordInput,
  actor: ActorContext,
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, actor.id)).limit(1);
  if (!user) throw notFound("El usuario");
  const check = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!check.valid) {
    throw validation("La contraseña actual no es correcta.", {
      currentPassword: ["No coincide con la contraseña actual."],
    });
  }
  const strength = evaluatePassword(input.newPassword, user.username);
  if (!strength.valid) {
    throw validation("La contraseña nueva no cumple los requisitos.", {
      newPassword: [...strength.problems],
    });
  }
  const passwordHash = await hashPassword(input.newPassword);
  await withTransaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        version: user.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    // Se cierran las demás sesiones: si alguien había robado una, deja de servir.
    await revokeAllUserSessions(
      user.id,
      "Cambio de contraseña",
      { exceptSessionId: actor.sessionId, revokedBy: user.id },
      tx,
    );
    await recordSecurityEvent(
      { type: "PASSWORD_CHANGED", userId: user.id, username: user.username, ip: actor.ip },
      tx,
    );
    await appendAuditLog(tx, {
      actor,
      action: "USER_PASSWORD_CHANGED",
      entity: "users",
      entityId: user.id,
      summary: "Cambió su propia contraseña",
    });
  });
}
export async function countActiveUsers(): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.active, true), isNull(users.deactivatedAt)));
  return row?.value ?? 0;
}
async function lockUser(tx: Transaction, id: string): Promise<User> {
  const [user] = await tx.select().from(users).where(eq(users.id, id)).limit(1).for("update");
  if (!user) throw notFound("El usuario");
  return user;
}
export async function listUserSessions(userId: string) {
  return db.query.sessions.findMany({
    where: (session, { eq: equals, and: all, isNull: nothing }) =>
      all(equals(session.userId, userId), nothing(session.revokedAt)),
    orderBy: (session, { desc: down }) => [down(session.lastSeenAt)],
    limit: 20,
  });
}
export { desc };
