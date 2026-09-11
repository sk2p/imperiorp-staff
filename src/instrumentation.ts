/**
 * Arranque del servidor.
 *
 * Next.js ejecuta `register()` una sola vez, antes de atender el primer
 * request. Se aprovecha para dejar la base lista sin pasos manuales: en
 * cualquier proveedor (Railway, Render, Fly, Docker, VPS) alcanza con definir
 * DATABASE_URL y arrancar.
 *
 * Poner `RUN_MIGRATIONS_ON_BOOT=false` desactiva el comportamiento, para quien
 * prefiera aplicar las migraciones como paso separado de su despliegue.
 */
export async function register(): Promise<void> {
  // El runtime Edge (middleware) no tiene acceso a la base ni al sistema de archivos.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getEnv, assertProductionSafety } = await import("@/lib/core/env");
  const { logger } = await import("@/lib/core/logger");

  try {
    const env = getEnv();

    const problems = assertProductionSafety();
    for (const problem of problems) {
      logger.error("Problema de configuración en producción", { problem });
    }

    if (process.env.RUN_MIGRATIONS_ON_BOOT === "false") {
      logger.info("Migraciones al arranque desactivadas por configuración");
      return;
    }

    const { runMigrations } = await import("@/db/migrate");
    await runMigrations();

    // Crea el usuario OWNER inicial si la base está vacía. Es idempotente.
    const { bootstrapOwner } = await import("@/db/seed");
    const result = await bootstrapOwner();

    if (result.password) {
      logger.warn("CONTRASEÑA INICIAL GENERADA — guardala ahora, no se vuelve a mostrar", {
        usuario: result.username,
        contrasena: result.password,
      });
    }

    logger.info("Aplicación lista", {
      entorno: env.NODE_ENV,
      zonaHoraria: env.APP_TIMEZONE,
    });
  } catch (error) {
    logger.error("Falló el arranque de la aplicación", { error });
    // Se relanza a propósito: es preferible que el contenedor no levante a que
    // quede sirviendo con la base a medio migrar.
    throw error;
  }
}
