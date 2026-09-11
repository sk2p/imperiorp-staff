import { getEnv } from "./env";

/**
 * Logger estructurado sin dependencias externas.
 *
 * Emite una línea JSON por evento (apto para Railway, Render, Fly, Docker,
 * Loki, Datadog, etc.) y redacta automáticamente cualquier campo sensible.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Claves cuyo valor jamás debe aparecer en un log. */
const REDACTED_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "newpassword",
  "currentpassword",
  "confirmpassword",
  "token",
  "rawtoken",
  "tokenhash",
  "secret",
  "sessionsecret",
  "authorization",
  "cookie",
  "csrf",
  "csrftoken",
]);

const REDACTION = "[redactado]";

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[profundidad máxima]";
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTION : redact(nested, depth + 1);
    }
    return output;
  }

  if (typeof value === "bigint") return value.toString();
  return value;
}

function currentThreshold(): number {
  try {
    return LEVEL_WEIGHT[getEnv().LOG_LEVEL];
  } catch {
    return LEVEL_WEIGHT.info;
  }
}

export interface LogFields {
  readonly [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < currentThreshold()) return;

  const payload = {
    ts: new Date().toISOString(),
    level,
    app: "imperio-rp-staff",
    msg: message,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const logger: Logger & { child(base: LogFields): Logger } = {
  debug: (message, fields) => emit("debug", message, fields),
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),

  /** Devuelve un logger con campos fijos (por ejemplo traceId y usuario). */
  child(base: LogFields): Logger {
    return {
      debug: (message, fields) => emit("debug", message, { ...base, ...fields }),
      info: (message, fields) => emit("info", message, { ...base, ...fields }),
      warn: (message, fields) => emit("warn", message, { ...base, ...fields }),
      error: (message, fields) => emit("error", message, { ...base, ...fields }),
    };
  },
};

export function newTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
