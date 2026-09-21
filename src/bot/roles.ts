import { and, eq, isNull, isNotNull, ne, sql } from "drizzle-orm";
import type { Guild, GuildMember } from "discord.js";

import { db, withTransaction, type Transaction } from "@/db";
import {
  hourEntries,
  rankRates,
  staffMembers,
  staffRankHistory,
  weeklyStaffRecords,
  weeks,
} from "@/db/schema";
import { localDate } from "@/domain/clock";
import { eachDayOfPeriod } from "@/domain/periods";
import {
  categoryForRank,
  compareRankChange,
  rankBaseOrder,
  rankLabel,
  rankTier,
  type StaffRank,
} from "@/domain/ranks";
import { systemActor } from "@/lib/auth/context";
import { logger } from "@/lib/core/logger";
import { appendAuditLog } from "@/server/audit";
import { ubicarEntreSuRango } from "@/server/orden-staff";
import { recalculateWeekRecords } from "@/server/weeks";

/**
 * IMPERIO RP — Sincronización automática de roles de Discord con la web/DB.
 *
 * Mapeo de IDs de rol en Discord a rangos de staff de Imperio RP.
 * Si un miembro tiene varios de estos roles, se selecciona el de mayor jerarquía (tier más alto).
 */
export const STAFF_ROLE_MAP: Readonly<Record<string, StaffRank>> = {
  "945562965787156500": "SDP", // Soporte de Prueba (Tier 1)
  "945562697993420813": "SP", // Soporte (Tier 2)
  "945562075252555846": "SE", // Soporte Experimentado (Tier 3)
  "945561723639836703": "MOD", // Moderador (Tier 4)
  "1114968517683450036": "MOD+", // Moderador+ (Tier 5)
  "945561389097955378": "MOD++", // Moderador++ (Tier 6)
  "945560648941715506": "ADM", // Administrador (Tier 7)
  "945560343256657950": "ADM+", // Administrador+ (Tier 8)
  "945560068986912808": "ADM++", // Administrador++ (Tier 9)
  "1298421134278262835": "SUBDG", // Subdirector General (Tier 10)
  "945559013603545098": "DG", // Directora General (Tier 11)
};

/** Determina el rango de staff más alto a partir de una lista de IDs de roles. */
export function obtenerRangoStaffDeRoles(roleIds: Iterable<string>): StaffRank | null {
  let mejorRango: StaffRank | null = null;
  let mayorTier = 0;

  for (const id of roleIds) {
    const rango = STAFF_ROLE_MAP[id];
    if (!rango) continue;
    const tier = rankTier(rango);
    if (tier > mayorTier) {
      mayorTier = tier;
      mejorRango = rango;
    }
  }

  return mejorRango;
}

export type TipoCambioSincronizacion =
  | "alta"
  | "ascenso"
  | "descenso"
  | "lateral"
  | "reincorporacion"
  | "baja"
  | "sin_cambios"
  | "no_staff";

export interface ResultadoSincronizacion {
  readonly tipo: TipoCambioSincronizacion;
  readonly staffMemberId?: string;
  readonly nombre?: string;
  readonly rangoAnterior?: string | null;
  readonly rangoNuevo?: string | null;
}

export interface ResumenSincronizacion {
  readonly total: number;
  readonly altas: number;
  readonly cambiosRango: number;
  readonly reincorporaciones: number;
  readonly bajas: number;
  readonly sinCambios: number;
}

/** Cola de promesas por usuario para evitar condiciones de carrera por eventos concurrentes. */
const colasPorUsuario = new Map<string, Promise<unknown>>();

function encolarPorUsuario<T>(userId: string, tarea: () => Promise<T>): Promise<T> {
  const anterior = colasPorUsuario.get(userId) ?? Promise.resolve();
  const siguiente = anterior.catch(() => {}).then(tarea);
  colasPorUsuario.set(userId, siguiente);
  siguiente.finally(() => {
    if (colasPorUsuario.get(userId) === siguiente) {
      colasPorUsuario.delete(userId);
    }
  });
  return siguiente;
}

/** Incorpora al nuevo staff en el período de liquidación abierto actualmente. */
async function joinStaffToOpenWeek(
  tx: Transaction,
  staffMemberId: string,
  today: string,
): Promise<{ weekId: string; markedDays: number } | null> {
  const [week] = await tx
    .select()
    .from(weeks)
    .where(eq(weeks.status, "open"))
    .orderBy(sql`start_date desc`)
    .limit(1);

  if (!week) return null;

  await tx.execute(sql`
    insert into weekly_staff_records (
      week_id, staff_member_id, staff_name_snapshot, rank_snapshot, category_snapshot,
      hourly_rate_snapshot, total_minutes, calculated_amount, entry_count
    )
    select ${week.id}::uuid, s.id, s.name, s.rank, s.category, r.rate_per_hour, 0, 0, 0
    from staff_members s
    join rank_rates r on r.rank = s.rank
    where s.id = ${staffMemberId}::uuid
    on conflict (week_id, staff_member_id) do nothing
  `);

  const previousDays = eachDayOfPeriod(week.startDate, week.endDate).filter((day) => day < today);

  for (const day of previousDays) {
    await tx
      .insert(hourEntries)
      .values({
        staffMemberId,
        weekId: week.id,
        workDate: day,
        minutes: 0,
        status: "no_ingresado",
        recordedBy: null,
        recordedByUsername: "sistema",
      })
      .onConflictDoNothing();
  }

  await recalculateWeekRecords(tx, week.id);

  return { weekId: week.id, markedDays: previousDays.length };
}

/**
 * Sincroniza un miembro de Discord con la base de datos de la web:
 * - Si tiene rol de staff y no existe -> Se crea (alta)
 * - Si tiene rol de staff y estaba archivado -> Se reactiva (reincorporación)
 * - Si tiene rol de staff y cambió de nivel -> Se actualiza su rango (ascenso/descenso)
 * - Si no tiene rol de staff y estaba activo -> Se archiva (baja)
 */
export async function sincronizarMiembroDiscord(
  member: GuildMember,
): Promise<ResultadoSincronizacion> {
  return encolarPorUsuario(member.id, async () => {
    const discordUserId = member.id;
    const discordTag = (member.user.tag || member.user.username || "").slice(0, 40);
    const rawName = (
      member.displayName ||
      member.user.displayName ||
      member.user.username ||
      "Staff"
    )
      .trim()
      .slice(0, 80);

    const targetRank = obtenerRangoStaffDeRoles(member.roles.cache.keys());

    // Buscar si ya existe una ficha con este ID de Discord
    const [existente] = await db
      .select()
      .from(staffMembers)
      .where(eq(staffMembers.discordUserId, discordUserId))
      .limit(1);

    // =========================================================================
    // Caso 1: El miembro ya tiene ficha vinculada a su discordUserId
    // =========================================================================
    if (existente) {
      if (targetRank !== null) {
        const category = categoryForRank(targetRank);

        // Subcaso 1A: Estaba archivado -> Reincorporar
        if (existente.archivedAt !== null) {
          return withTransaction(async (tx) => {
            const [duplicado] = await tx
              .select({ id: staffMembers.id })
              .from(staffMembers)
              .where(
                and(
                  sql`lower(${staffMembers.name}) = ${existente.name.toLowerCase()}`,
                  isNull(staffMembers.archivedAt),
                  ne(staffMembers.id, existente.id),
                ),
              )
              .limit(1);

            const nombreFinal = duplicado
              ? `${existente.name} (${discordUserId.slice(-4)})`
              : existente.name;

            await tx
              .update(staffMembers)
              .set({
                name: nombreFinal,
                rank: targetRank,
                category,
                active: true,
                archivedAt: null,
                archivedBy: null,
                archiveReason: null,
                discordTag,
                version: existente.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(staffMembers.id, existente.id));

            await ubicarEntreSuRango(tx, existente.id, targetRank);

            await tx.insert(staffRankHistory).values({
              staffMemberId: existente.id,
              fromRank: existente.rank,
              toRank: targetRank,
              changeType: "reincorporacion",
              reason: "Reincorporación automática por rol de Discord",
              changedBy: null,
              changedByUsername: "sistema",
            });

            await joinStaffToOpenWeek(tx, existente.id, localDate(new Date()));

            await appendAuditLog(tx, {
              actor: systemActor("Sincronización Discord"),
              action: "STAFF_RESTORED",
              entity: "staff_members",
              entityId: existente.id,
              summary: `Reincorporó automáticamente a ${nombreFinal} como ${rankLabel(targetRank)} (${targetRank})`,
              before: { rango: existente.rank, archivado: true },
              after: { rango: targetRank, archivado: false },
              reason: "Asignación de rol de staff en Discord",
            });

            logger.info("Miembro de staff reincorporado por rol de Discord", {
              id: existente.id,
              nombre: nombreFinal,
              rango: targetRank,
              discordUserId,
            });

            return {
              tipo: "reincorporacion",
              staffMemberId: existente.id,
              nombre: nombreFinal,
              rangoAnterior: existente.rank,
              rangoNuevo: targetRank,
            };
          });
        }

        // Subcaso 1B: Está activo pero cambió de rango
        if (existente.rank !== targetRank) {
          const changeType = compareRankChange(existente.rank, targetRank);

          return withTransaction(async (tx) => {
            await tx
              .update(staffMembers)
              .set({
                rank: targetRank,
                category,
                discordTag,
                version: existente.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(staffMembers.id, existente.id));

            await ubicarEntreSuRango(tx, existente.id, targetRank);

            await tx.insert(staffRankHistory).values({
              staffMemberId: existente.id,
              fromRank: existente.rank,
              toRank: targetRank,
              changeType,
              reason: `Cambio automático de rango por rol en Discord (${changeType})`,
              changedBy: null,
              changedByUsername: "sistema",
            });

            await appendAuditLog(tx, {
              actor: systemActor("Sincronización Discord"),
              action: "STAFF_RANK_CHANGED",
              entity: "staff_members",
              entityId: existente.id,
              summary: `Cambió el rango de ${existente.name}: ${existente.rank} → ${targetRank} (${changeType})`,
              before: { rango: existente.rank, categoria: existente.category },
              after: { rango: targetRank, categoria: category },
              reason: "Actualización de roles en Discord",
              metadata: { tipoDeCambio: changeType },
            });

            logger.info(`Rango de staff actualizado automáticamente (${changeType})`, {
              id: existente.id,
              nombre: existente.name,
              anterior: existente.rank,
              nuevo: targetRank,
              discordUserId,
            });

            return {
              tipo: changeType,
              staffMemberId: existente.id,
              nombre: existente.name,
              rangoAnterior: existente.rank,
              rangoNuevo: targetRank,
            };
          });
        }

        // Subcaso 1C: Mismo rango y activo, solo actualizar discordTag si cambió
        if (existente.discordTag !== discordTag) {
          await db
            .update(staffMembers)
            .set({ discordTag, updatedAt: new Date() })
            .where(eq(staffMembers.id, existente.id));
        }

        return {
          tipo: "sin_cambios",
          staffMemberId: existente.id,
          nombre: existente.name,
          rangoAnterior: existente.rank,
          rangoNuevo: targetRank,
        };
      } else {
        // Subcaso 1D: Ya no tiene roles de staff en Discord -> Baja / Archivar
        if (existente.archivedAt === null) {
          return withTransaction(async (tx) => {
            const now = new Date();
            await tx
              .update(staffMembers)
              .set({
                active: false,
                archivedAt: now,
                archiveReason: "Baja automática: se removieron los roles de staff en Discord",
                version: existente.version + 1,
                updatedAt: now,
              })
              .where(eq(staffMembers.id, existente.id));

            await appendAuditLog(tx, {
              actor: systemActor("Sincronización Discord"),
              action: "STAFF_ARCHIVED",
              entity: "staff_members",
              entityId: existente.id,
              summary: `Archivó automáticamente a ${existente.name} (${existente.rank}) por remoción de roles en Discord`,
              before: { rango: existente.rank, activo: true },
              after: { rango: existente.rank, activo: false, archivedAt: now.toISOString() },
              reason: "Remoción de roles de staff en Discord",
            });

            logger.info("Miembro de staff dado de baja automáticamente por remoción de roles", {
              id: existente.id,
              nombre: existente.name,
              rango: existente.rank,
              discordUserId,
            });

            return {
              tipo: "baja",
              staffMemberId: existente.id,
              nombre: existente.name,
              rangoAnterior: existente.rank,
              rangoNuevo: null,
            };
          });
        }

        return { tipo: "sin_cambios" };
      }
    }

    // =========================================================================
    // Caso 2: El miembro NO tiene ficha vinculada
    // =========================================================================
    if (targetRank === null) {
      // Usuario común de Discord sin rol de staff
      return { tipo: "no_staff" };
    }

    // Tiene rol de staff pero no está vinculado. Verificar si existe por nombre sin vincular:
    const [coincidenciaNombre] = await db
      .select()
      .from(staffMembers)
      .where(
        and(
          sql`lower(${staffMembers.name}) = ${rawName.toLowerCase()}`,
          isNull(staffMembers.archivedAt),
          isNull(staffMembers.discordUserId),
        ),
      )
      .limit(1);

    if (coincidenciaNombre) {
      return withTransaction(async (tx) => {
        const changeType =
          coincidenciaNombre.rank !== targetRank
            ? compareRankChange(coincidenciaNombre.rank, targetRank)
            : null;
        const category = categoryForRank(targetRank);

        await tx
          .update(staffMembers)
          .set({
            discordUserId,
            discordTag,
            rank: targetRank,
            category,
            version: coincidenciaNombre.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(staffMembers.id, coincidenciaNombre.id));

        if (changeType) {
          await ubicarEntreSuRango(tx, coincidenciaNombre.id, targetRank);
          await tx.insert(staffRankHistory).values({
            staffMemberId: coincidenciaNombre.id,
            fromRank: coincidenciaNombre.rank,
            toRank: targetRank,
            changeType,
            reason: `Vínculo automático y actualización a ${targetRank} por Discord`,
            changedBy: null,
            changedByUsername: "sistema",
          });
        }

        await appendAuditLog(tx, {
          actor: systemActor("Sincronización Discord"),
          action: "STAFF_UPDATED",
          entity: "staff_members",
          entityId: coincidenciaNombre.id,
          summary: `Vinculó automáticamente Discord de ${coincidenciaNombre.name} (${targetRank})`,
          after: { discordUserId, discordTag, rank: targetRank },
          reason: "Detección de rol de staff en Discord",
        });

        logger.info("Ficha de staff existente vinculada automáticamente con Discord", {
          id: coincidenciaNombre.id,
          nombre: coincidenciaNombre.name,
          rango: targetRank,
          discordUserId,
        });

        return {
          tipo: changeType ?? "alta",
          staffMemberId: coincidenciaNombre.id,
          nombre: coincidenciaNombre.name,
          rangoAnterior: coincidenciaNombre.rank,
          rangoNuevo: targetRank,
        };
      });
    }

    // No existe -> CREAR NUEVO MIEMBRO DEL STAFF
    return withTransaction(async (tx) => {
      const [duplicado] = await tx
        .select({ id: staffMembers.id })
        .from(staffMembers)
        .where(
          and(
            sql`lower(${staffMembers.name}) = ${rawName.toLowerCase()}`,
            isNull(staffMembers.archivedAt),
          ),
        )
        .limit(1);

      const nombreFinal = duplicado ? `${rawName} (${discordUserId.slice(-4)})` : rawName;
      const category = categoryForRank(targetRank);

      const [creado] = await tx
        .insert(staffMembers)
        .values({
          name: nombreFinal,
          rank: targetRank,
          category,
          discordUserId,
          discordTag,
          active: true,
          joinedAt: localDate(new Date()),
          displayOrder: rankBaseOrder(targetRank),
          version: 1,
        })
        .returning();

      if (!creado) throw new Error("No se pudo registrar el nuevo miembro de staff.");

      await ubicarEntreSuRango(tx, creado.id, targetRank);

      await tx.insert(staffRankHistory).values({
        staffMemberId: creado.id,
        fromRank: null,
        toRank: targetRank,
        changeType: "alta",
        reason: "Alta automática por detección de rol en Discord",
        changedBy: null,
        changedByUsername: "sistema",
      });

      await joinStaffToOpenWeek(tx, creado.id, localDate(new Date()));

      await appendAuditLog(tx, {
        actor: systemActor("Sincronización Discord"),
        action: "STAFF_CREATED",
        entity: "staff_members",
        entityId: creado.id,
        summary: `Dio de alta automáticamente a ${creado.name} como ${rankLabel(targetRank)} (${targetRank})`,
        after: {
          name: creado.name,
          rank: targetRank,
          category,
          discordUserId,
          discordTag,
        },
        reason: "Detección de rol de staff en servidor de Discord",
      });

      logger.info("Nuevo miembro de staff registrado automáticamente desde Discord", {
        id: creado.id,
        nombre: creado.name,
        rango: targetRank,
        discordUserId,
      });

      return {
        tipo: "alta",
        staffMemberId: creado.id,
        nombre: creado.name,
        rangoAnterior: null,
        rangoNuevo: targetRank,
      };
    });
  });
}

/**
 * Escanea y sincroniza todos los miembros de un servidor con roles de staff.
 * También archiva a los miembros activos que ya no posean roles de staff en el servidor.
 */
export async function sincronizarGremioCompleto(guild: Guild): Promise<ResumenSincronizacion> {
  logger.info("Obteniendo miembros del servidor para sincronización...", {
    servidor: guild.name,
    guildId: guild.id,
  });

  const members = await guild.members.fetch();
  let altas = 0;
  let cambiosRango = 0;
  let reincorporaciones = 0;
  let bajas = 0;
  let sinCambios = 0;

  const vistosEnServidor = new Set<string>();

  for (const [, member] of members) {
    vistosEnServidor.add(member.id);

    try {
      const res = await sincronizarMiembroDiscord(member);
      if (res.tipo === "alta") altas++;
      else if (res.tipo === "ascenso" || res.tipo === "descenso" || res.tipo === "lateral")
        cambiosRango++;
      else if (res.tipo === "reincorporacion") reincorporaciones++;
      else if (res.tipo === "baja") bajas++;
      else if (res.tipo === "sin_cambios") sinCambios++;
    } catch (error) {
      logger.error("Error al sincronizar miembro durante barrido completo", {
        userId: member.id,
        nombre: member.displayName,
        error,
      });
    }
  }

  // Verificar miembros en DB vinculados por discordUserId que ya no están en el servidor
  try {
    const activosEnDb = await db
      .select({
        id: staffMembers.id,
        name: staffMembers.name,
        rank: staffMembers.rank,
        discordUserId: staffMembers.discordUserId,
      })
      .from(staffMembers)
      .where(and(isNotNull(staffMembers.discordUserId), isNull(staffMembers.archivedAt)));

    for (const staff of activosEnDb) {
      if (staff.discordUserId && !vistosEnServidor.has(staff.discordUserId)) {
        await withTransaction(async (tx) => {
          const now = new Date();
          await tx
            .update(staffMembers)
            .set({
              active: false,
              archivedAt: now,
              archiveReason: "Baja automática: ya no forma parte del servidor de Discord",
              updatedAt: now,
            })
            .where(eq(staffMembers.id, staff.id));

          await appendAuditLog(tx, {
            actor: systemActor("Sincronización Discord"),
            action: "STAFF_ARCHIVED",
            entity: "staff_members",
            entityId: staff.id,
            summary: `Archivó automáticamente a ${staff.name} (${staff.rank}): ya no está en el servidor de Discord`,
            reason: "Miembro fuera del servidor de Discord",
          });
        });
        bajas++;
        logger.info("Miembro de staff dado de baja por no encontrarse en Discord", {
          id: staff.id,
          name: staff.name,
          discordUserId: staff.discordUserId,
        });
      }
    }
  } catch (error) {
    logger.error("Error al revisar miembros de staff salidos del servidor", { error });
  }

  return {
    total: members.size,
    altas,
    cambiosRango,
    reincorporaciones,
    bajas,
    sinCambios,
  };
}
