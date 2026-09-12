"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  requestMetadata,
  requireAuth,
  requireFounder,
  requirePermission,
} from "@/lib/auth/context";
import { forbidden, isAppError, notFound } from "@/lib/core/errors";
import { logger, newTraceId } from "@/lib/core/logger";
import { PERMISSIONS } from "@/domain/permissions";
import { formatMinutes } from "@/domain/time";
import { formatMoney } from "@/domain/money";
import { performLogin, performLogout } from "@/server/auth-flow";
import {
  archiveStaffMember,
  changeStaffRank,
  createStaffMember,
  restoreStaffMember,
  updateStaffMember,
} from "@/server/staff";
import {
  createBulkHourEntries,
  createHourEntry,
  updateHourEntry,
  voidHourEntry,
} from "@/server/hours";
import {
  createBulkPayments,
  createPayment,
  togglePaymentFromBoard,
  updatePayment,
  voidPayment,
} from "@/server/payments";
import { addMemberToWeek, closeWeek, createWeek, reopenWeek, updateWeek } from "@/server/weeks";
import { changeOwnPassword, createUser, resetUserPassword, updateUser } from "@/server/users";
import { updateRankRate, updateSetting } from "@/server/settings";
import { revokeOwnSession, revokeSessionById } from "@/lib/auth/session";
import { releaseLock } from "@/lib/auth/rate-limit";
import {
  archiveStaffSchema,
  changeRankSchema,
  createStaffSchema,
  restoreStaffSchema,
  updateStaffSchema,
} from "@/validation/staff";
import {
  bulkHourEntriesSchema,
  createHourEntrySchema,
  updateHourEntrySchema,
  voidHourEntrySchema,
} from "@/validation/hours";
import {
  bulkPaymentSchema,
  createPaymentSchema,
  updatePaymentSchema,
  togglePaymentSchema,
  voidPaymentSchema,
} from "@/validation/payments";
import {
  addMemberToWeekSchema,
  closeWeekSchema,
  createWeekSchema,
  reopenWeekSchema,
  updateWeekSchema,
} from "@/validation/weeks";
import {
  changeOwnPasswordSchema,
  createUserSchema,
  loginSchema,
  resetUserPasswordSchema,
  revokeSessionSchema,
  updateUserSchema,
} from "@/validation/users";
import { updateRankRateSchema, updateSettingSchema } from "@/validation/system";
import {
  changeRankInlineSchema,
  removeFromGridSchema,
  reorderSchema,
  resetWeekSchema,
  setCellSchema,
  setDayStatusSchema,
  updateGroupRatesSchema,
  updateRankColorsSchema,
} from "@/validation/grid";
import {
  changeRankFromGrid,
  reorderStaff,
  resetWeekHours,
  setDayStatus,
  setGridCell,
} from "@/server/grid";
import { updateGroupRates, updateRankColors } from "@/server/settings";
import { z } from "zod";
import { runAction, type ActionState } from "./helpers";

const P = PERMISSIONS;

/** Refresca las pantallas afectadas por un cambio de datos. */
function revalidateAll(): void {
  for (const path of [
    "/",
    "/horas",
    "/staff",
    "/pagos",
    "/periodos",
    "/estadisticas",
    "/historial",
    "/auditoria",
  ]) {
    revalidatePath(path, "page");
  }
}

/* ========================================================================== */
/* Autenticación                                                              */
/* ========================================================================== */

export async function loginAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  const parsed = loginSchema.safeParse({
    username: formData.get("username")?.toString() ?? "",
    password: formData.get("password")?.toString() ?? "",
    redirectTo: formData.get("redirectTo")?.toString(),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Completá usuario y contraseña.",
      code: "VALIDATION",
    };
  }

  const metadata = await requestMetadata();

  try {
    await performLogin(parsed.data, {
      ip: metadata.ip ?? "desconocida",
      userAgent: metadata.userAgent,
    });
  } catch (error) {
    /**
     * Sólo se muestra el mensaje de un `AppError`, que está escrito a propósito
     * para el usuario. Cualquier otra excepción —una consulta fallida, un
     * problema de red con la base— se degrada a un mensaje genérico.
     *
     * Devolver `error.message` a secas filtraba la consulta SQL entera, con
     * nombres de tablas y columnas, a una pantalla que ve cualquiera sin estar
     * autenticado.
     */
    if (isAppError(error)) {
      return {
        status: "error",
        message: error.message,
        code: error.code,
      };
    }

    const traceId = newTraceId();
    logger.error("Error inesperado durante el acceso", { error, traceId });

    return {
      status: "error",
      message: "No se pudo iniciar sesión. Probá de nuevo en un momento. (ref " + traceId + ")",
      code: "INTERNAL",
    };
  }

  // `redirect` lanza una excepción de control de Next: va fuera del try/catch.
  redirect(parsed.data.redirectTo ?? "/");
}

export async function logoutAction(): Promise<never> {
  const context = await requireAuth().catch(() => null);
  await performLogout({ ip: context?.actor.ip, username: context?.actor.username });
  redirect("/ingresar");
}

export async function changePasswordAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: null,
      schema: changeOwnPasswordSchema,
      success: "Contraseña actualizada. Se cerraron tus otras sesiones.",
    },
    async (input, context) => {
      await changeOwnPassword(input, context.actor);
      revalidatePath("/perfil");
    },
  );
}

/* ========================================================================== */
/* Staff                                                                      */
/* ========================================================================== */

export async function createStaffAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.STAFF_CREATE, schema: createStaffSchema, success: "Miembro dado de alta." },
    async (input, context) => {
      const member = await createStaffMember(input, context.actor);
      revalidateAll();
      return { id: member.id, name: member.name };
    },
  );
}

export async function updateStaffAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.STAFF_EDIT, schema: updateStaffSchema, success: "Datos actualizados." },
    async (input, context) => {
      await updateStaffMember(input, context.actor);
      revalidateAll();
    },
  );
}

export async function changeRankAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.STAFF_CHANGE_RANK,
      schema: changeRankSchema,
      success: "Rango actualizado. Las liquidaciones cerradas no se modificaron.",
    },
    async (input, context) => {
      await changeStaffRank(input, context.actor);
      revalidateAll();
    },
  );
}

export async function archiveStaffAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.STAFF_DELETE,
      schema: archiveStaffSchema,
      success: "Miembro archivado. Su historial se conserva completo.",
    },
    async (input, context) => {
      await archiveStaffMember(input, context.actor);
      revalidateAll();
    },
  );
}

export async function restoreStaffAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.STAFF_EDIT, schema: restoreStaffSchema, success: "Miembro reincorporado." },
    async (input, context) => {
      await restoreStaffMember(input.id, input.reason, context.actor);
      revalidateAll();
    },
  );
}

/* ========================================================================== */
/* Horas                                                                      */
/* ========================================================================== */

export async function createHourEntryAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.HOURS_CREATE,
      schema: createHourEntrySchema,
      success: "Horas registradas.",
    },
    async (input, context) => {
      const entry = await createHourEntry(input, context.actor);
      revalidateAll();
      return { id: entry.id, minutes: entry.minutes };
    },
  );
}

export async function createBulkHoursAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.HOURS_CREATE,
      schema: bulkHourEntriesSchema,
      success: (result) => {
        const value = result as { created: number; totalMinutes: number };
        return (
          "Se registraron " +
          formatMinutes(value.totalMinutes) +
          " en " +
          value.created +
          " miembros."
        );
      },
    },
    async (input, context) => {
      const result = await createBulkHourEntries(input, context.actor);
      revalidateAll();
      return result;
    },
  );
}

export async function updateHourEntryAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.HOURS_EDIT,
      schema: updateHourEntrySchema,
      success: "Horas corregidas. El cambio quedó auditado.",
    },
    async (input, context) => {
      await updateHourEntry(input, context.actor);
      revalidateAll();
    },
  );
}

export async function voidHourEntryAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.HOURS_DELETE,
      schema: voidHourEntrySchema,
      success: "Entrada anulada. Queda registrada en el historial.",
    },
    async (input, context) => {
      await voidHourEntry(input, context.actor);
      revalidateAll();
    },
  );
}

/* ========================================================================== */
/* Planilla semanal                                                           */
/* ========================================================================== */

export async function setCellAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.HOURS_EDIT, schema: setCellSchema, success: "Horas guardadas." },
    async (input, context) => {
      await setGridCell(input, context.actor);
      revalidatePath("/horas");
      revalidatePath("/");
    },
  );
}

export async function setDayStatusAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.HOURS_EDIT, schema: setDayStatusSchema, success: "Día actualizado." },
    async (input, context) => {
      await setDayStatus(input, context.actor);
      revalidatePath("/horas");
      revalidatePath("/");
    },
  );
}

export async function changeRankInlineAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.STAFF_CHANGE_RANK,
      schema: changeRankInlineSchema,
      success: "Rango actualizado. Las liquidaciones cerradas no se tocaron.",
    },
    async (input, context) => {
      await changeRankFromGrid(input, context.actor);
      revalidateAll();
    },
  );
}

export async function resetWeekAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.HOURS_DELETE,
      schema: resetWeekSchema,
      success: (result) => {
        const value = result as { cleared: number };
        return "Semana reiniciada: " + value.cleared + " registro(s) anulados.";
      },
    },
    async (input, context) => {
      const result = await resetWeekHours(input.weekId, context.actor);
      revalidateAll();
      return result;
    },
  );
}

export async function updateGroupRatesAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.SETTINGS_RATES,
      schema: updateGroupRatesSchema,
      success: "Tarifas guardadas. Sólo cambian los períodos abiertos.",
    },
    async (input, context) => {
      await updateGroupRates(input, context.actor);
      revalidateAll();
      revalidatePath("/configuracion");
    },
  );
}

export async function updateRankColorsAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.SETTINGS_MANAGE,
      schema: updateRankColorsSchema,
      success: "Colores guardados.",
    },
    async (input, context) => {
      await updateRankColors(input.colors, context.actor);
      revalidatePath("/horas");
      revalidatePath("/configuracion");
    },
  );
}

export async function reorderAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.STAFF_EDIT, schema: reorderSchema, success: "Orden guardado." },
    async (input, context) => {
      await reorderStaff(input.staffMemberIds, context.actor);
      revalidatePath("/horas");
      revalidatePath("/staff");
    },
  );
}

export async function removeFromGridAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.STAFF_DELETE,
      schema: removeFromGridSchema,
      success: "Miembro archivado. Su historial se conserva.",
    },
    async (input, context) => {
      const { requireStaffMember } = await import("@/server/staff");
      const member = await requireStaffMember(input.staffMemberId);

      await archiveStaffMember(
        {
          id: member.id,
          expectedVersion: member.version,
          reason: input.reason ?? "Baja desde la planilla de horas",
          // El nombre ya se confirmó en el diálogo, que muestra de quién se trata.
          confirmName: member.name,
        },
        context.actor,
      );

      revalidateAll();
    },
  );
}

/* ========================================================================== */
/* Períodos                                                                   */
/* ========================================================================== */

export async function createWeekAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.WEEKS_CREATE, schema: createWeekSchema, success: "Período abierto." },
    async (input, context) => {
      const week = await createWeek(input, context.actor);
      revalidateAll();
      return { id: week.id };
    },
  );
}

export async function updateWeekAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.WEEKS_CREATE, schema: updateWeekSchema, success: "Período actualizado." },
    async (input, context) => {
      await updateWeek(input, context.actor);
      revalidateAll();
    },
  );
}

export async function closeWeekAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.WEEKS_CLOSE,
      schema: closeWeekSchema,
      success: "Período cerrado. Las liquidaciones quedaron congeladas.",
    },
    async (input, context) => {
      await closeWeek(input, context.actor);
      revalidateAll();
    },
  );
}

export async function reopenWeekAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.WEEKS_REOPEN,
      schema: reopenWeekSchema,
      success: "Período reabierto. Recordá volver a cerrarlo cuando termines.",
    },
    async (input, context) => {
      await reopenWeek(input, context.actor);
      revalidateAll();
    },
  );
}

export async function addMemberToWeekAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.HOURS_CREATE,
      schema: addMemberToWeekSchema,
      success: "Miembro agregado al período.",
    },
    async (input, context) => {
      await addMemberToWeek(input.weekId, input.staffMemberId, context.actor);
      revalidateAll();
    },
  );
}

/* ========================================================================== */
/* Pagos                                                                      */
/* ========================================================================== */

export async function createPaymentAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.PAYMENTS_CREATE,
      schema: createPaymentSchema,
      success: "Pago registrado.",
    },
    async (input, context) => {
      const payment = await createPayment(input, context.actor);
      revalidateAll();
      return { id: payment.id, amount: payment.amount };
    },
  );
}

export async function createBulkPaymentsAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.PAYMENTS_CREATE,
      schema: bulkPaymentSchema,
      success: (result) => {
        const value = result as { created: number; skipped: number; totalAmount: number };
        return (
          "Se registraron " +
          value.created +
          " pagos por " +
          formatMoney(value.totalAmount) +
          (value.skipped > 0 ? " (" + value.skipped + " ya estaban pagados)." : ".")
        );
      },
    },
    async (input, context) => {
      const result = await createBulkPayments(input, context.actor);
      revalidateAll();
      return result;
    },
  );
}

export async function updatePaymentAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: P.PAYMENTS_EDIT, schema: updatePaymentSchema, success: "Pago actualizado." },
    async (input, context) => {
      await updatePayment(input, context.actor);
      revalidateAll();
    },
  );
}

export async function voidPaymentAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.PAYMENTS_VOID,
      schema: voidPaymentSchema,
      success: "Pago anulado. Ya podés registrar el correcto.",
    },
    async (input, context) => {
      await voidPayment(input, context.actor);
      revalidateAll();
    },
  );
}

/**
 * Marcar o desmarcar el pago de un miembro desde el tablero.
 *
 * Son dos operaciones distintas detrás de un mismo gesto, y cada una pide lo
 * suyo: marcar exige poder registrar pagos; desmarcar, poder anularlos. Quien
 * puede pagar pero no anular ve el error explicando por qué, en vez de un
 * botón que a veces funciona y a veces no.
 */
export async function togglePaymentAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.PAYMENTS_CREATE,
      schema: togglePaymentSchema,
      success: (result) => {
        const value = result as { paid: boolean; name: string; amount: number };
        return value.paid
          ? value.name + " figura como pagado — " + formatMoney(value.amount) + "."
          : value.name + " vuelve a figurar como pendiente.";
      },
    },
    async (input, context) => {
      if (!input.paid && !context.can(P.PAYMENTS_VOID)) {
        throw forbidden(
          "Podés registrar pagos, pero no anularlos. Para volver a marcar a alguien como pendiente hace falta el permiso de anulación.",
        );
      }

      const result = await togglePaymentFromBoard(input, context.actor);
      revalidateAll();
      return result;
    },
  );
}

/* ========================================================================== */
/* Usuarios y sistema                                                         */
/* ========================================================================== */

export async function createUserAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  // Exclusivo del Fundador: el permiso por sí solo no alcanza.
  await requireFounder();
  return runAction(
    formData,
    { permission: P.USERS_CREATE, schema: createUserSchema, success: "Usuario creado." },
    async (input, context) => {
      const user = await createUser(input, context.actor);
      revalidatePath("/configuracion/usuarios");
      return { id: user.id, username: user.username };
    },
  );
}

export async function updateUserAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  // Exclusivo del Fundador: el permiso por sí solo no alcanza.
  await requireFounder();
  return runAction(
    formData,
    { permission: P.USERS_EDIT, schema: updateUserSchema, success: "Usuario actualizado." },
    async (input, context) => {
      await updateUser(input, context.actor);
      revalidatePath("/configuracion/usuarios");
    },
  );
}

export async function resetPasswordAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  // Exclusivo del Fundador: el permiso por sí solo no alcanza.
  await requireFounder();
  return runAction(
    formData,
    {
      permission: P.USERS_RESET_PASSWORD,
      schema: resetUserPasswordSchema,
      success: "Contraseña restablecida. Copiala ahora: no se vuelve a mostrar.",
    },
    async (input, context) => {
      const result = await resetUserPassword(input, context.actor);
      revalidatePath("/configuracion/usuarios");
      return result;
    },
  );
}

/**
 * Cerrar una sesión propia desde Mi cuenta.
 *
 * No pide permiso especial: cualquiera puede echar a un dispositivo suyo. El
 * servidor comprueba que la sesión sea de quien la pide, así que mandar el
 * identificador de otro no cierra nada.
 */
export async function closeOwnSessionAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    { permission: null, schema: revokeSessionSchema, success: "Sesión cerrada." },
    async (input, context) => {
      const closed = await revokeOwnSession(input.sessionId, context.user.id);
      if (!closed) throw notFound("Esa sesión");

      // Si cerró la suya, el layout la echa al login en el próximo render.
      revalidatePath("/perfil");
    },
  );
}

export async function revokeSessionAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  // Exclusivo del Fundador: el permiso por sí solo no alcanza.
  await requireFounder();
  return runAction(
    formData,
    {
      permission: P.USERS_REVOKE_SESSIONS,
      schema: revokeSessionSchema,
      success: "Sesión revocada.",
    },
    async (input, context) => {
      await revokeSessionById(
        input.sessionId,
        "Revocada por un administrador",
        context.actor.id ?? undefined,
      );
      revalidatePath("/configuracion/seguridad");
    },
  );
}

export async function releaseLockAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.SETTINGS_MANAGE,
      schema: z.object({ bucketKey: z.string().min(1).max(120) }),
      success: "Bloqueo liberado.",
    },
    async (input) => {
      await releaseLock(input.bucketKey);
      revalidatePath("/configuracion/seguridad");
    },
  );
}

export async function updateRateAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.SETTINGS_RATES,
      schema: updateRankRateSchema,
      success: "Tarifa actualizada. Sólo cambian los períodos abiertos.",
    },
    async (input, context) => {
      await updateRankRate(input, context.actor);
      revalidateAll();
      revalidatePath("/configuracion/tarifas");
    },
  );
}

export async function updateSettingAction(
  _previous: ActionState<unknown>,
  formData: FormData,
): Promise<ActionState<unknown>> {
  return runAction(
    formData,
    {
      permission: P.SETTINGS_MANAGE,
      schema: updateSettingSchema,
      success: "Configuración guardada.",
    },
    async (input, context) => {
      await updateSetting(input, context.actor);
      revalidatePath("/configuracion");
    },
  );
}

/** Verificación manual de la cadena de auditoría. */
export async function verifyAuditAction(): Promise<{ ok: boolean; message: string }> {
  await requirePermission(P.AUDIT_VIEW);
  const { verifyAuditChain } = await import("@/server/audit");
  const result = await verifyAuditChain();
  return { ok: result.ok, message: result.message };
}
