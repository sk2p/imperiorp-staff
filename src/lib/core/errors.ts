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

/* -------------------------------------------------------------------------- */
/* Errores de PostgreSQL                                                      */
/* -------------------------------------------------------------------------- */

/** Violación de índice único. */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Busca el código SQLSTATE de un error, esté donde esté.
 *
 * Cada driver lo envuelve distinto: `pg` lo deja arriba de todo, PGlite lo
 * mete en `cause`, y Drizzle a veces agrega otra capa. Si no se mira en las
 * tres, el `catch` no reconoce el error y al usuario le llega la consulta SQL
 * entera en pantalla en lugar de "ya tenés un fichaje abierto".
 */
export function pgErrorCode(error: unknown): string | null {
  let actual: unknown = error;

  for (let nivel = 0; nivel < 4 && actual !== null && typeof actual === "object"; nivel += 1) {
    const codigo = (actual as { code?: unknown }).code;
    if (typeof codigo === "string" && /^[0-9A-Z]{5}$/.test(codigo)) return codigo;
    actual = (actual as { cause?: unknown }).cause;
  }

  return null;
}

export function isUniqueViolation(error: unknown, constraintHint?: string): boolean {
  if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) return false;
  if (!constraintHint) return true;

  const texto = JSON.stringify(
    error instanceof Error
      ? { m: error.message, c: (error as { constraint?: unknown }).constraint }
      : error,
  );
  return texto.includes(constraintHint);
}

/**
 * Un problema pasajero de conexión con la base, no un error del programa.
 *
 * El plan gratuito de Neon duerme la base cuando nadie la usa. La primera
 * consulta después de un rato la despierta, y mientras tanto la conexión puede
 * cortarse o agotar su tiempo. No hay nada roto: hay que volver a intentar.
 *
 * Se reconocen tanto los códigos de PostgreSQL para caída de conexión como los
 * de red de Node, porque según dónde se corte llega uno u otro.
 */
const TRANSITORIOS = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now: justamente, la base arrancando
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
]);

const FRASES_TRANSITORIAS = [
  "connection terminated",
  "timeout exceeded when trying to connect",
  "connection ended unexpectedly",
  "server closed the connection",
  "terminating connection",
];

export function isTransientDatabaseError(error: unknown): boolean {
  const codigo = pgErrorCode(error);
  if (codigo && TRANSITORIOS.has(codigo)) return true;

  // Los errores de red de Node traen el código en `code` pero no con forma
  // SQLSTATE, así que `pgErrorCode` los descarta: se miran aparte.
  let actual: unknown = error;
  for (let nivel = 0; nivel < 4 && actual !== null && typeof actual === "object"; nivel += 1) {
    const suelto = (actual as { code?: unknown }).code;
    if (typeof suelto === "string" && TRANSITORIOS.has(suelto)) return true;
    actual = (actual as { cause?: unknown }).cause;
  }

  const mensaje = error instanceof Error ? error.message.toLowerCase() : "";
  return FRASES_TRANSITORIAS.some((frase) => mensaje.includes(frase));
}
