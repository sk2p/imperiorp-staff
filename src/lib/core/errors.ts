/**
 * Sistema de errores tipados.
 *
 * Regla: el cliente nunca ve un mensaje que no haya sido escrito a propósito
 * para él. Cualquier excepción no controlada se convierte en un error genérico
 * con un `traceId` que permite encontrarla en los logs del servidor.
 */

export const ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  CONFLICT: "CONFLICT",
  CONCURRENCY: "CONCURRENCY",
  RATE_LIMITED: "RATE_LIMITED",
  BUSINESS_RULE: "BUSINESS_RULE",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  CONCURRENCY: 409,
  RATE_LIMITED: 429,
  BUSINESS_RULE: 400,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** Detalles seguros para mostrar al usuario (por ejemplo, errores por campo). */
  readonly details?: Readonly<Record<string, string[]>>;
  /** Contexto interno que sólo va a los logs, nunca al cliente. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** Segundos a esperar antes de reintentar (429). */
  readonly retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, string[]>>;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
  /** Marca que el mensaje fue redactado para el usuario final. */
  readonly expose = true;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.context = options.context;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/* -------------------------------------------------------------------------- */
/* Constructores                                                              */
/* -------------------------------------------------------------------------- */

export const unauthenticated = (
  message = "Tenés que iniciar sesión para continuar.",
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.UNAUTHENTICATED, message, options);

export const forbidden = (
  message = "No tenés permiso para realizar esta acción.",
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.FORBIDDEN, message, options);

export const notFound = (entity: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.NOT_FOUND, entity + " no encontrado.", options);

export const validation = (
  message: string,
  details?: Readonly<Record<string, string[]>>,
): AppError => new AppError(ERROR_CODES.VALIDATION, message, { details });

export const conflict = (message: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.CONFLICT, message, options);

export const concurrency = (
  message = "Otro usuario modificó este registro mientras lo editabas. Volvé a cargarlo y reintentá.",
  options?: AppErrorOptions,
): AppError => new AppError(ERROR_CODES.CONCURRENCY, message, options);

export const rateLimited = (message: string, retryAfterSeconds: number): AppError =>
  new AppError(ERROR_CODES.RATE_LIMITED, message, { retryAfterSeconds });

export const businessRule = (message: string, options?: AppErrorOptions): AppError =>
  new AppError(ERROR_CODES.BUSINESS_RULE, message, options);

export const internal = (context?: Readonly<Record<string, unknown>>, cause?: unknown): AppError =>
  new AppError(ERROR_CODES.INTERNAL, "Ocurrió un error interno. El equipo fue notificado.", {
    context,
    cause,
  });

/* -------------------------------------------------------------------------- */
/* Serialización segura                                                       */
/* -------------------------------------------------------------------------- */

export interface SerializedError {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string[]>>;
  readonly retryAfterSeconds?: number;
  readonly traceId?: string;
}

/**
 * Convierte cualquier excepción en una respuesta apta para el cliente.
 * Los errores desconocidos se degradan a INTERNAL sin filtrar el mensaje original.
 */
export function serializeError(error: unknown, traceId?: string): SerializedError {
  if (isAppError(error)) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      ...(error.code === ERROR_CODES.INTERNAL && traceId ? { traceId } : {}),
    };
  }

  return {
    ok: false,
    code: ERROR_CODES.INTERNAL,
    message: "Ocurrió un error interno. El equipo fue notificado.",
    ...(traceId ? { traceId } : {}),
  };
}

export function httpStatusFor(error: unknown): number {
  return isAppError(error) ? error.status : 500;
}
