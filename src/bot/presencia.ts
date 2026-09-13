import { ActivityType, type Client } from "discord.js";

import { logger } from "@/lib/core/logger";
import { listActiveShifts } from "@/server/shifts";

/**
 * IMPERIO RP — El estado del bot: cuántos hay en servicio.
 *
 * Se ve en la lista de miembros del servidor sin abrir nada: "🟢 5 en
 * servicio". Es la pregunta que más se hace en el canal de staff, y ahora la
 * contesta el propio bot con estar conectado.
 *
 * No se consulta con un temporizador propio. Contar cada minuto tendría a la
 * base despierta las veinticuatro horas por un número que sólo cambia cuando
 * alguien ficha. Se recalcula justo ahí —después de una entrada, una salida o
 * de la revisión de cada diez minutos—, cuando la base ya está despierta por
 * esa misma operación.
 */

/** El último número publicado. Discord limita los cambios de estado. */
let ultimo: number | null = null;

export async function actualizarPresencia(client: Client): Promise<void> {
  if (!client.user) return;

  try {
    const activos = (await listActiveShifts()).length;
    if (activos === ultimo) return;
    ultimo = activos;

    client.user.setPresence({
      status: "online",
      activities: [
        {
          type: ActivityType.Custom,
          name: "fichaje",
          state:
            activos === 0
              ? "Nadie en servicio"
              : "🟢 " + activos + (activos === 1 ? " en servicio" : " en servicio"),
        },
      ],
    });
  } catch (error) {
    // Un estado desactualizado no rompe nada: se reintenta en la próxima.
    ultimo = null;
    logger.warn("No se pudo actualizar el estado del bot", { error });
  }
}
