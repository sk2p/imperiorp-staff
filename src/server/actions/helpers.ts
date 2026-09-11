import "server-only";

import type { z } from "zod";

import { requireAuth, requirePermission, type AuthContext } from "@/lib/auth/context";
import { assertCsrfToken, CSRF_FIELD } from "@/lib/auth/csrf";
import { isAppError, serializeError, type ErrorCode } from "@/lib/core/errors";
import { logger, newTraceId } from "@/lib/core/logger";
import type { Permission } from "@/domain/permissions";
import { recordSecurityEvent } from "@/server/security-events";

/**
 * Envoltura común de todas las Server Actions.
 *
 * Cada acción pasa obligatoriamente por la misma secuencia:
 *   sesión → permiso → token anti-CSRF → validación → ejecución → respuesta.
 *
 * Ningún paso es opcional ni se puede saltear desde el cliente, y el resultado
 * que vuelve al navegador nunca contiene un mensaje de error no redactado.
 */

export type ActionState<TData = undefined> =
  | { readonly status: "idle" }
  | { readonly status: "success"; readonly message: string; readonly data?: TData }
  | {
      readonly status: "error";
      readonly message: string;
      readonly code: ErrorCode;
      readonly fieldErrors?: Readonly<Record<string, string[]>>;
      readonly traceId?: string;
    };

export const idleState: ActionState<never> = { status: "idle" };

export function successState<TData>(message: string, data?: TData): ActionState<TData> {
  return data === undefined ? { status: "success", message } : { status: "success", message, data };
}

/**
 * Convierte los datos de un formulario en un objeto plano.
 * Los campos repetidos (checkboxes múltiples) se agrupan en un array.
 */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    if (key === CSRF_FIELD) continue;

    // Un sufijo [] declara explícitamente que el campo es una lista.
    const isList = key.endsWith("[]");
    const name = isList ? key.slice(0, -2) : key;
    const existing = result[name];

    if (isList || existing !== undefined) {
      const current = Array.isArray(existing) ? existing : existing === undefined ? [] : [existing];
      result[name] = [...current, value];
    } else {
      result[name] = value;
    }
  }

  return result;
}

export interface ActionOptions<TSchema extends z.ZodType> {
  /** Permiso exigido. `null` sólo para acciones que basta con estar autenticado. */
  readonly permission: Permission | null;
  readonly schema: TSchema;
  /** Mensaje de éxito. Puede depender del resultado. */
  readonly success: string | ((result: unknown) => string);
}

/**
 * Ejecuta una acción con todas las barreras aplicadas.
 *
 * Los errores de dominio (`AppError`) vuelven con su mensaje, pensado para el
 * usuario. Cualquier otra excepción se registra con un `traceId` y al cliente
 * le llega un mensaje genérico: un stack trace o un error de PostgreSQL en
 * pantalla es información gratis para quien esté probando el sistema.
 */
export async function runAction<TSchema extends z.ZodType, TResult>(
  formData: FormData,
  options: ActionOptions<TSchema>,
  handler: (input: z.infer<TSchema>, context: AuthContext) => Promise<TResult>,
): Promise<ActionState<TResult>> {
  const traceId = newTraceId();

  try {
    const context = options.permission
      ? await requirePermission(options.permission)
      : await requireAuth();

    assertCsrfToken(context.session.id, formData.get(CSRF_FIELD)?.toString() ?? null);

    const parsed = options.schema.safeParse(formDataToObject(formData));
    if (!parsed.success) {
      return {
        status: "error",
        message: "Revisá los datos del formulario.",
        code: "VALIDATION",
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    }

    const result = await handler(parsed.data, context);

    return {
      status: "success",
      message: typeof options.success === "function" ? options.success(result) : options.success,
      data: result,
    };
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === "FORBIDDEN" || error.code === "UNAUTHENTICATED") {
        await recordSecurityEvent({
          type: error.code === "FORBIDDEN" ? "PERMISSION_DENIED" : "SESSION_EXPIRED",
          details: { permiso: options.permission, traceId },
        });
      }

      if (error.code === "INTERNAL") {
        logger.error("Error interno en una acción", { error, traceId });
      } else {
        logger.warn("Acción rechazada", {
          traceId,
          code: error.code,
          message: error.message,
          context: error.context,
        });
      }

      const serialized = serializeError(error, traceId);
      return {
        status: "error",
        message: serialized.message,
        code: serialized.code,
        ...(serialized.details ? { fieldErrors: serialized.details } : {}),
        ...(serialized.traceId ? { traceId } : {}),
      };
    }

    logger.error("Excepción no controlada en una acción", { error, traceId });
    return {
      status: "error",
      message: "Ocurrió un error inesperado. Guardá este código si necesitás soporte: " + traceId,
      code: "INTERNAL",
      traceId,
    };
  }
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_form";
    result[key] = [...(result[key] ?? []), issue.message];
  }

  return result;
}
