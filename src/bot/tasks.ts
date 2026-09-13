import type { Client, ContainerBuilder } from "discord.js";

import { logger } from "@/lib/core/logger";
import { localDate, previousLocalDate, startOfLocalDay } from "@/domain/clock";
import { GROUP_DEFINITIONS, STAFF_GROUPS } from "@/domain/groups";
import {
  autoCloseStaleShifts,
  dailyReport,
  findWeekByCode,
  frozenSettlement,
  todayIsCovered,
} from "@/server/shifts";
import { ensureCurrentPeriod, rotatePeriodIfDue } from "@/server/rotation";
import { crearCopia, podarCopias } from "@/db/backup";
import { COLOR, GROUP_COLOR, allGroupChannels, botConfig, groupChannels } from "./config";
import {
  avisoCierrePeriodo,
  periodoAbiertoSolo,
  registroFichaje,
  reporteDiario,
  sinPeriodoParaHoy,
} from "./ui";

/**
 * IMPERIO RP — Las dos tareas que corren solas.
 *
 *   · A medianoche se publica el resumen del día que terminó: uno por bloque en
 *     su canal, y uno global con todo el staff.
 *   · A medianoche también se guarda una copia de seguridad de la base entera.
 *   · Cada diez minutos se cierran los fichajes que quedaron abiertos de más y
 *     se controla que el día de hoy caiga adentro de algún período abierto. Si
 *     no lo hay, se abre el de la semana —de sábado a viernes— y se anuncia.
 *
 * El reloj es el local, no el del servidor donde corra el bot. Si esto se muda
 * a una máquina en otro huso, la medianoche sigue siendo la de Argentina.
 */

type Publicar = (channelId: string | null, contenedor: ContainerBuilder) => Promise<void>;

/** Cada cuánto se buscan fichajes olvidados. */
const REVISION_MS = 10 * 60 * 1000;

/** Qué día se reportó por última vez, para no repetir si el proceso se reinicia. */
let ultimoReportado: string | null = null;

/** Qué día se avisó por última vez que hoy no entra en ningún período. */
let ultimoAvisoSinPeriodo: string | null = null;

export function startScheduler(client: Client, publicar: Publicar): void {
  // Al arrancar se limpia lo que haya quedado colgado de la corrida anterior.
  void revisarVencidos(publicar);
  void revisarCobertura(publicar);

  setInterval(() => {
    void revisarVencidos(publicar);
    void revisarCobertura(publicar);
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
      // La rotación va DESPUÉS del resumen: primero se reporta el día que
      // terminó, y recién ahí se cierra el período si corresponde.
      .then(() => rotarPeriodo(publicar))
      .catch((error: unknown) => logger.error("Falló la rotación del período", { error }))
      // Y al final, la copia del día: después de que todo lo del día quedó
      // asentado, para que la copia contenga el cierre y no lo de antes.
      .then(() => copiaDiaria())
      .finally(() => programarMedianoche(publicar));
  }, espera);
}

/* -------------------------------------------------------------------------- */
/* Rotación del período                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cierra el período vencido, abre el siguiente y lo anuncia.
 *
 * Esto ya existía como tarea programada de Vercel, pero depende de un secreto
 * que hoy no está configurado, así que nunca llegó a correr. El bot está
 * prendido las veinticuatro horas igual: es el lugar natural para esto.
 *
 * `rotatePeriodIfDue` decide sola si corresponde y es idempotente, así que
 * llamarla todas las noches no duplica nada. Y si una noche el bot estuvo
 * caído, a la siguiente cierra igual el período vencido en vez de dejar dos
 * semanas mezcladas en la misma liquidación.
 */
export async function rotarPeriodo(publicar: Publicar): Promise<void> {
  const resultado = await rotatePeriodIfDue();

  if (!resultado.acted) {
    logger.info("Rotación evaluada: no correspondía", { motivo: resultado.reason });
    return;
  }

  logger.info("Período rotado", { motivo: resultado.reason });

  const config = botConfig();
  const destino = config.resumenGlobal ?? config.pagos;
  if (!destino || !resultado.closedWeek || !resultado.openedWeek) return;

  const cerrada = await findWeekByCode(resultado.closedWeek.code);
  const lineas = cerrada ? await frozenSettlement(cerrada) : [];

  await publicar(
    destino,
    avisoCierrePeriodo({
      cerrado: resultado.closedWeek,
      abierto: resultado.openedWeek,
      lineas,
    }),
  );
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

/* -------------------------------------------------------------------------- */
/* Copia de seguridad diaria                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Una copia por día, junto con el resumen de medianoche.
 *
 * Todo el sistema vive en una base en la nube. Sin una copia afuera, un borrado
 * accidental o un problema del proveedor se lleva las horas, los pagos y el
 * historial entero, y no hay de dónde volver.
 *
 * Va acá y no en la tarea programada de la web porque el archivo tiene que
 * quedar en algún disco: en Vercel el disco se borra al terminar cada pedido.
 * Mientras el bot corra en una máquina de verdad, la copia queda ahí.
 *
 * Si falla, se anota y se sigue. Una copia que no se pudo hacer no puede
 * arruinar el resumen del día ni frenar los fichajes.
 */
async function copiaDiaria(): Promise<void> {
  try {
    const carpeta = process.env.CARPETA_COPIAS?.trim() || "copias";

    const resultado = await crearCopia(carpeta);
    const borradas = await podarCopias(carpeta);

    logger.info("Copia de seguridad creada", {
      archivo: resultado.archivo,
      kilobytes: Math.round(resultado.bytes / 1024),
      filas: resultado.filas,
      viejasBorradas: borradas,
    });
  } catch (error) {
    logger.error("Falló la copia de seguridad diaria", { error });
  }
}

/* -------------------------------------------------------------------------- */
/* Días que no entran en ningún período                                       */
/* -------------------------------------------------------------------------- */

/**
 * Controla que el día de hoy caiga adentro de algún período abierto.
 *
 * Un fichaje se anota en el período que CONTIENE el día trabajado. Si hoy no
 * cae en ninguno, el turno se cierra bien y las horas se informan como
 * salteadas — pero sólo lo ve quien fichó. Nadie más se entera hasta que esa
 * persona reclama su sueldo y la hora no está en ningún lado.
 *
 * El aviso va una vez por día y no cada diez minutos. Una alarma que se repite
 * sin parar se silencia, y una alarma silenciada no sirve para nada.
 */
async function revisarCobertura(publicar: Publicar): Promise<void> {
  try {
    const hoy = localDate();
    if (ultimoAvisoSinPeriodo === hoy) return;

    const { cubierto } = await todayIsCovered();
    if (cubierto) return;

    const config = botConfig();

    /**
     * Primero se intenta arreglarlo, y recién si no se pudo se toca la alarma.
     * Avisar de un problema que el propio bot puede resolver es entrenar a la
     * gente para ignorar los avisos.
     */
    const creado = await ensureCurrentPeriod(hoy);

    if (creado.created && creado.week) {
      logger.info("Período abierto automáticamente", { hoy, periodo: creado.week.code });
      await publicar(
        config.resumenGlobal ?? config.pagos,
        periodoAbiertoSolo(creado.week, creado.reason.includes("recortado")),
      );
      return;
    }

    const { proximo } = await todayIsCovered();
    ultimoAvisoSinPeriodo = hoy;
    logger.warn("El día de hoy no entra en ningún período y no se pudo abrir uno", {
      hoy,
      motivo: creado.reason,
      proximo,
    });

    await publicar(config.resumenGlobal ?? config.pagos, sinPeriodoParaHoy(hoy, proximo));
  } catch (error) {
    logger.error("Falló el control de cobertura del día", { error });
  }
}

/** Para probar el resumen a mano desde la consola, sin esperar a medianoche. */
export function gruposConResumen(): readonly string[] {
  return STAFF_GROUPS.filter((g) => groupChannels(g).resumen !== null).map(
    (g) => GROUP_DEFINITIONS[g].label,
  );
}
