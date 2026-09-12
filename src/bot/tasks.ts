import type { Client, ContainerBuilder } from "discord.js";

import { logger } from "@/lib/core/logger";
import { localDate, previousLocalDate, startOfLocalDay } from "@/domain/clock";
import { GROUP_DEFINITIONS, STAFF_GROUPS } from "@/domain/groups";
import { autoCloseStaleShifts, dailyReport } from "@/server/shifts";
import { COLOR, GROUP_COLOR, allGroupChannels, botConfig, groupChannels } from "./config";
import { registroFichaje, reporteDiario } from "./ui";

/**
 * IMPERIO RP — Las dos tareas que corren solas.
 *
 *   · A medianoche se publica el resumen del día que terminó: uno por bloque en
 *     su canal, y uno global con todo el staff.
 *   · Cada diez minutos se cierran los fichajes que quedaron abiertos de más.
 *
 * El reloj es el local, no el del servidor donde corra el bot. Si esto se muda
 * a una máquina en otro huso, la medianoche sigue siendo la de Argentina.
 */

type Publicar = (channelId: string | null, contenedor: ContainerBuilder) => Promise<void>;

/** Cada cuánto se buscan fichajes olvidados. */
const REVISION_MS = 10 * 60 * 1000;

/** Qué día se reportó por última vez, para no repetir si el proceso se reinicia. */
let ultimoReportado: string | null = null;

export function startScheduler(client: Client, publicar: Publicar): void {
  // Al arrancar se limpia lo que haya quedado colgado de la corrida anterior.
  void revisarVencidos(publicar);

  setInterval(() => {
    void revisarVencidos(publicar);
  }, REVISION_MS);

  programarMedianoche(publicar);

  logger.info("Tareas programadas del bot activas", {
    revisionCadaMinutos: REVISION_MS / 60000,
    proximoResumen: proximaMedianoche().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Resumen diario                                                             */
/* -------------------------------------------------------------------------- */

function proximaMedianoche(): Date {
  const manana = new Date(startOfLocalDay(localDate()).getTime() + 26 * 3600 * 1000);
  // Se parte del mediodía del día siguiente para que un cambio de horario no
  // deje el cálculo un día corrido, y de ahí se toma su medianoche local.
  return startOfLocalDay(localDate(manana));
}

function programarMedianoche(publicar: Publicar): void {
  const objetivo = proximaMedianoche();
  // Treinta segundos de margen: los fichajes que cierran justo a las 00:00
  // tienen tiempo de asentarse antes de que se arme el resumen.
  const espera = Math.max(1000, objetivo.getTime() - Date.now() + 30_000);

  setTimeout(() => {
    void publicarResumen(publicar)
      .catch((error: unknown) => logger.error("Falló el resumen diario", { error }))
      .finally(() => programarMedianoche(publicar));
  }, espera);
}

export async function publicarResumen(publicar: Publicar, fecha?: string): Promise<void> {
  const dia = fecha ?? previousLocalDate(localDate());

  if (ultimoReportado === dia) {
    logger.info("El resumen de ese día ya se publicó", { dia });
    return;
  }

  const config = botConfig();

  // Uno por bloque, en su canal.
  for (const canales of allGroupChannels()) {
    if (!canales.resumen) continue;

    const lineas = await dailyReport(dia, canales.group);
    await publicar(
      canales.resumen,
      reporteDiario({
        titulo: "Reporte diario · " + canales.label,
        fecha: dia,
        lineas,
        color: GROUP_COLOR[canales.group],
      }),
    );
  }

  // Y uno con todo el staff junto.
  if (config.resumenGlobal) {
    const lineas = await dailyReport(dia);
    await publicar(
      config.resumenGlobal,
      reporteDiario({
        titulo: "Reporte global del staff",
        fecha: dia,
        lineas,
        color: COLOR.reporte,
        global: true,
      }),
    );
  }

  ultimoReportado = dia;
  logger.info("Resumen diario publicado", { dia });
}

/* -------------------------------------------------------------------------- */
/* Fichajes olvidados                                                         */
/* -------------------------------------------------------------------------- */

async function revisarVencidos(publicar: Publicar): Promise<void> {
  try {
    const cerrados = await autoCloseStaleShifts();
    if (cerrados.length === 0) return;

    logger.warn("Fichajes cerrados automáticamente", { cantidad: cerrados.length });

    for (const resultado of cerrados) {
      await publicar(groupChannels(resultado.member.group).registro, registroFichaje(resultado));
    }
  } catch (error) {
    logger.error("Falló la revisión de fichajes vencidos", { error });
  }
}

/** Para probar el resumen a mano desde la consola, sin esperar a medianoche. */
export function gruposConResumen(): readonly string[] {
  return STAFF_GROUPS.filter((g) => groupChannels(g).resumen !== null).map(
    (g) => GROUP_DEFINITIONS[g].label,
  );
}
