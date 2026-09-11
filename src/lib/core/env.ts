import { z } from "zod";

/**
 * Validación centralizada de variables de entorno.
 *
 * Se evalúa de forma perezosa (lazy) para que `next build` no falle en entornos
 * de CI donde todavía no existe `DATABASE_URL`. En runtime, el primer acceso
 * valida y cachea el resultado; si algo falta, el error es explícito y accionable.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase()),
  );

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Cadena de conexión PostgreSQL estándar. Compatible con Railway, Supabase,
   * Neon, Render, Docker o cualquier PostgreSQL propio.
   * Si se omite en desarrollo, la app usa PGlite embebido.
   */
  DATABASE_URL: z
    .string()
    .trim()
    .optional()
    // Una variable presente pero vacía (habitual en paneles de hosting) equivale
    // a no haberla definido.
    .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),

  /** Fuerza SSL en la conexión aunque el host no sea remoto. */
  DATABASE_SSL: booleanish.optional(),

  /** Tamaño máximo del pool de conexiones. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  /**
   * Secreto usado para derivar el pepper del hash de contraseñas y para firmar
   * el token CSRF. Cambiarlo invalida todas las sesiones y contraseñas.
   */
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET debe tener al menos 32 caracteres")
    .default("dev-only-insecure-secret-please-change-me-32+"),

  /** URL pública de la aplicación. Se usa para validar el origen (anti-CSRF). */
  APP_URL: z.string().url().default("http://localhost:3000"),

  /** Zona horaria operativa de Imperio RP. Afecta a cómo se muestran las fechas. */
  APP_TIMEZONE: z.string().default("America/Argentina/Buenos_Aires"),

  /** Duración de la sesión en días. */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /** Intentos fallidos antes del bloqueo temporal de la cuenta. */
  MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),

  /** Ventana y duración del bloqueo, en minutos. */
  LOGIN_LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /** Credenciales del primer usuario OWNER, creado por el seed/bootstrap. */
  INITIAL_ADMIN_USERNAME: z.string().trim().min(3).default("owner"),
  INITIAL_ADMIN_PASSWORD: z.string().min(8).optional(),

  /** Nivel de log: debug | info | warn | error. */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  · ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Configuración de entorno inválida:\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** Reinicia la caché. Sólo se usa en tests. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === "production";
}

export function isTest(): boolean {
  return getEnv().NODE_ENV === "test";
}

/**
 * Verificaciones que sólo tienen sentido en producción. Se ejecuta en el
 * arranque del servidor y en `/api/ready`.
 */
export function assertProductionSafety(): string[] {
  const env = getEnv();
  const problems: string[] = [];

  if (env.NODE_ENV !== "production") return problems;

  if (!env.DATABASE_URL) {
    problems.push("DATABASE_URL no está definida: en producción no se permite PGlite embebido.");
  }
  if (env.SESSION_SECRET.startsWith("dev-only-")) {
    problems.push("SESSION_SECRET sigue siendo el valor de desarrollo.");
  }
  if (env.SESSION_SECRET.includes("change-this")) {
    problems.push("SESSION_SECRET contiene un valor de ejemplo. Generá uno nuevo.");
  }
  if (env.APP_URL.startsWith("http://") && !env.APP_URL.includes("localhost")) {
    problems.push("APP_URL usa http:// en producción. Las cookies Secure requieren https://.");
  }

  return problems;
}
