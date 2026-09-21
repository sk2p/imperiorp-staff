import { MessageFlags, type Client, type ContainerBuilder } from "discord.js";

import { logger } from "@/lib/core/logger";
import { localDate, previousLocalDate, startOfLocalDay } from "@/domain/clock";
import { GROUP_DEFINITIONS, STAFF_GROUPS } from "@/domain/groups";
import {
  MAX_SHIFT_HOURS,
  autoCloseStaleShifts,
  dailyReport,
  findWeekByCode,
  frozenSettlement,
  listActiveShifts,
  todayIsCovered,
  type ActiveShift,
} from "@/server/shifts";
import { ensureCurrentPeriod, rotatePeriodIfDue } from "@/server/rotation";
import { crearCopia, podarCopias } from "@/db/backup";
import { discordDeFundadores } from "@/server/cuentas-discord";
import {
  COLOR,
  GROUP_COLOR,
  allGroupChannels,
  botConfig,
  groupChannels,
  urlPaginaVigilada,
} from "./config";
import { actualizarPresencia } from "./presencia";
import {
  avisoCierrePeriodo,
  avisoPaginaCaida,
  avisoPaginaVolvio,
  periodoAbiertoSolo,
  recordatorioFichaje,
  registroFichaje,
  reporteDiario,
  sinPeriodoParaHoy,
} from "./ui";
import { ESTADO_VIGIA_INICIAL, consultarPagina, evaluarChequeo } from "./vigia";

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

/* -------------------------------------------------------------------------- */
/* Recordatorio de fichajes largos                                            */
/* -------------------------------------------------------------------------- */

/** A cuántas horas de fichaje abierto se le escribe a la persona. */
const AVISOS_HORAS = [5, 10] as const;

/**
 * Cuántos recordatorios recibió ya cada fichaje abierto.
 *
 * En memoria y a propósito. Guardarlo en la base pediría una columna nueva
 * para un dato que vale unas horas. Lo que se pierde es que, si el bot se
 * reinicia después de un aviso, esa persona puede recibirlo otra vez en la
 * vuelta siguiente. Un privado repetido molesta menos que tocar el esquema.
 */
const recordados = new Map<string, number>();

/**
 * Le escribe por privado a quien lleva muchas horas fichado.
 *
 * El cierre automático de las dieciséis horas cuida la planilla, pero llega
 * tarde: para entonces ya se contaron horas que nadie trabajó. Esto pregunta a
 * las cinco y a las diez, cuando todavía se arregla con un toque.
 */
async function recordarFichajesLargos(client: Client): Promise<void> {
  let abiertos: readonly ActiveShift[];
  try {
    abiertos = await listActiveShifts();
  } catch (error) {
    logger.warn("No se pudieron revisar los fichajes largos", { error });
    return;
  }

  // Los que ya se cerraron no necesitan memoria.
  const vigentes = new Set(abiertos.map((abierto) => abierto.sessionId));
  for (const id of recordados.keys()) {
    if (!vigentes.has(id)) recordados.delete(id);
  }

  for (const abierto of abiertos) {
    if (!abierto.discordUserId) continue;

    const horas = abierto.seconds / 3600;

    // Ya lo corta el cierre automático: un aviso a esta altura llega tarde.
    if (horas >= MAX_SHIFT_HOURS) continue;

    // Cuántos umbrales pasó. Si el bot estuvo caído un rato no llegan dos
    // avisos juntos, sólo el que corresponde ahora.
    const alcanzados = AVISOS_HORAS.filter((umbral) => horas >= umbral).length;
    if (alcanzados === 0 || (recordados.get(abierto.sessionId) ?? 0) >= alcanzados) continue;

    recordados.set(abierto.sessionId, alcanzados);

    try {
      const usuario = await client.users.fetch(abierto.discordUserId);
      await usuario.send({
        components: [
          recordatorioFichaje({
            rank: abierto.rank,
            name: abierto.name,
            sessionId: abierto.sessionId,
            startedAt: abierto.startedAt,
            seconds: abierto.seconds,
            cierreAutomaticoHoras: MAX_SHIFT_HOURS,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });

      logger.info("Recordatorio de fichaje largo enviado", {
        staff: abierto.name,
        horas: Math.floor(horas),
      });
    } catch (error) {
      // Privados cerrados, o la persona ya no está en el servidor.
      logger.warn("No se pudo mandar el recordatorio de fichaje", { staff: abierto.name, error });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Vigilancia de la página                                                    */
/* -------------------------------------------------------------------------- */

/** Cada cuánto se mira la página. La base, una vuelta sí y una no. */
const VIGIA_MS = 5 * 60 * 1000;

/** Tras un fallo suelto, cuánto se espera para confirmarlo antes de avisar. */
const VIGIA_REINTENTO_MS = 60 * 1000;

/** Cada cuánto se vuelve a leer quiénes son los fundadores. */
const FUNDADORES_MS = 60 * 60 * 1000;

let estadoVigia = ESTADO_VIGIA_INICIAL;

/**
 * A quién avisar, guardado en memoria.
 *
 * Se lee de la base, y justo cuando hay que avisar la base puede estar caída.
 * Por eso se lee mientras anda y se guarda: si lo que se cae es la base, el
 * aviso sale igual, con la lista de la última vez.
 */
let fundadores: readonly string[] = [];
let fundadoresLeidosEn = 0;

async function refrescarFundadores(): Promise<void> {
  if (fundadoresLeidosEn > 0 && Date.now() - fundadoresLeidosEn < FUNDADORES_MS) return;

  try {
    fundadores = await discordDeFundadores();
    fundadoresLeidosEn = Date.now();

    if (fundadores.length === 0) {
      logger.warn(
        "Ningún fundador tiene su Discord vinculado a su ficha: si la página se cae, no hay a quién avisar",
      );
    }
  } catch (error) {
    logger.warn("No se pudo leer a quién avisar si la página se cae", { error });
  }
}

async function avisarFundadores(client: Client, contenedor: ContainerBuilder): Promise<void> {
  if (fundadores.length === 0) {
    logger.warn("La vigilancia tiene algo que avisar, pero no hay a quién");
    return;
  }

  for (const id of fundadores) {
    try {
      const usuario = await client.users.fetch(id);
      await usuario.send({ components: [contenedor], flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      // Privados cerrados: queda en el log, que también es donde se ve la caída.
      logger.warn("No se pudo mandar el aviso de la vigilancia", { error });
    }
  }
}

async function chequearPagina(client: Client, base: string, profundo: boolean): Promise<void> {
  const chequeo = await consultarPagina(base, {
    profundo,
    // Con el secreto, la página dice qué parte falla; sin él, sólo que falla.
    secreto: process.env.CRON_SECRET?.trim() || undefined,
  });

  const { estado, decision } = evaluarChequeo(estadoVigia, chequeo, {
    ahora: new Date(),
    profundo,
  });
  estadoVigia = estado;

  // Con la base respondiendo es el momento de leer a quién avisar.
  if (chequeo.ok && profundo) await refrescarFundadores();

  if (decision.tipo === "reintentar") {
    logger.warn("La página no respondió bien; se vuelve a probar en un minuto", {
      motivo: chequeo.ok ? null : chequeo.motivo,
    });
    setTimeout(() => void chequearPagina(client, base, profundo), VIGIA_REINTENTO_MS);
    return;
  }

  if (decision.tipo === "avisar-caida") {
    logger.error("La página no está andando", { motivo: decision.motivo });
    await avisarFundadores(
      client,
      avisoPaginaCaida({ url: base, motivo: decision.motivo, desde: decision.desde }),
    );
    return;
  }

  if (decision.tipo === "avisar-vuelta") {
    logger.info("La página volvió", { minutos: Math.round(decision.duracionMs / 60_000) });
    await avisarFundadores(
      client,
      avisoPaginaVolvio({ url: base, desde: decision.desde, duracionMs: decision.duracionMs }),
    );
  }
}

/**
 * Arranca la vigilancia. Las razones de cada cosa están en `vigia.ts`.
 *
 * Arranca en el mismo instante que la revisión de fichajes y con el doble de
 * frecuencia, así que las vueltas que miran la base caen justo cuando la
 * revisión ya la despertó. Con una caída avisada, en cambio, se mira completo
 * en cada vuelta: ahí importa enterarse rápido de que volvió.
 */
function vigilarPagina(client: Client): void {
  const base = urlPaginaVigilada();
  if (!base) {
    logger.info("Vigilancia de la página apagada (URL_PAGINA=no)");
    return;
  }

  // La lista se lee ya, por si lo primero que pasa es que la página no anda.
  void refrescarFundadores();

  let vuelta = 0;
  const mirar = () => {
    const profundo = estadoVigia.avisada || vuelta % 2 === 0;
    vuelta += 1;
    void chequearPagina(client, base, profundo).catch((error: unknown) =>
      logger.error("Falló la vigilancia de la página", { error }),
    );
  };

  mirar();
  setInterval(mirar, VIGIA_MS);

  logger.info("Vigilancia de la página activa", { url: base, cadaMinutos: VIGIA_MS / 60_000 });
}

export function startScheduler(client: Client, publicar: Publicar): void {
  // Al arrancar se limpia lo que haya quedado colgado de la corrida anterior.
  void revisarVencidos(publicar).then(() => actualizarPresencia(client));
  void revisarCobertura(publicar);

  setInterval(() => {
    // En fila y no en paralelo: el recordatorio tiene que ver la lista DESPUÉS
    // de los cierres automáticos, o le escribiría a alguien cuyo fichaje se
    // acaba de cerrar solo.
    void revisarVencidos(publicar)
      .then(() => recordarFichajesLargos(client))
      .then(() => actualizarPresencia(client));
    void revisarCobertura(publicar);
  }, REVISION_MS);

  // Justo después de la revisión: sus vueltas con base coinciden con las de ella.
  vigilarPagina(client);

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
      fueraDeLaMaquina: resultado.subida,
    });

    /**
     * Que la copia quede sólo en este disco no es un detalle: es la mitad del
     * trabajo sin hacer. Se avisa una vez por día, con el resto del resumen, en
     * vez de quedar enterrado en un log que nadie abre.
     */
    if (!resultado.subida) {
      logger.warn(
        "La copia quedó sólo en esta máquina: configurá DISCORD_BACKUP_WEBHOOK para sacarla de acá",
      );
    }
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
