import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import { formatDuration, localDateTime } from "@/domain/clock";
import { GROUP_DEFINITIONS, type StaffGroup } from "@/domain/groups";
import { formatMoney } from "@/domain/money";
import { formatMinutes } from "@/domain/time";
import { COLOR, GROUP_COLOR } from "./config";
import { emoji, emojiBoton } from "./emojis";
import type { ActiveShift, CloseResult, DailyLine, PeriodOverview } from "@/server/shifts";

/**
 * IMPERIO RP — Las pantallas del bot.
 *
 * Todo se arma con Components V2: contenedores con filo de color, texto,
 * separadores y —esto es lo que no se podía con los embeds viejos— los botones
 * adentro del mismo bloque, no colgando abajo. Un panel es una sola pieza.
 *
 * Dos reglas del formato que conviene tener presentes:
 *   · Con Components V2 el mensaje NO puede llevar `content` ni `embeds`. Todo
 *     es componentes, o Discord rechaza el mensaje.
 *   · Ningún emoji se escribe acá a mano: todos salen de `emojis.ts`, para que
 *     cambiarlos por los personalizados de Imperio RP sea editar el `.env`.
 */

function texto(contenido: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(contenido);
}

function separador(grande = false): SeparatorBuilder {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(grande ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
}

function fila(
  ...botones: readonly ButtonBuilder[]
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...botones);
}

/** De "2026-09-12" a "12/09/2026", que es como se leen las fechas acá. */
function fechaLegible(iso: string): string {
  const [anio, mes, dia] = iso.split("-");
  return dia + "/" + mes + "/" + anio;
}

/** Etiqueta del staff como se ve en los registros: `[ADM++] Pit`. */
export function etiqueta(rank: string, name: string): string {
  return "`[" + rank + "]` **" + name + "**";
}

/** El emoji que identifica a cada bloque de staff. */
function emojiGrupo(group: StaffGroup): string {
  if (group === "HIGH_STAFF") return emoji("HIGH");
  if (group === "MID_STAFF") return emoji("MID");
  return emoji("LOW");
}

/* -------------------------------------------------------------------------- */
/* Panel de fichaje                                                           */
/* -------------------------------------------------------------------------- */

/**
 * El panel que queda fijo en cada canal de fichaje.
 *
 * Hay uno por bloque y los botones llevan el bloque en su identificador, así
 * que siguen funcionando después de reiniciar el bot: no hay estado en memoria
 * que se pierda, el mensaje se explica solo.
 */
export function panelFichaje(group: StaffGroup) {
  const definicion = GROUP_DEFINITIONS[group];

  return new ContainerBuilder()
    .setAccentColor(GROUP_COLOR[group])
    .addTextDisplayComponents(
      texto(
        "## " +
          emojiGrupo(group) +
          " Fichaje · " +
          definicion.label +
          "\nRegistrá tu **entrada** cuando empieces y tu **salida** cuando termines.\n" +
          "El tiempo se cuenta solo y va directo a la planilla de horas.",
      ),
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto("-# Si te olvidaste de dar salida, avisale a un administrador para que te lo corrija."),
    )
    .addActionRowComponents(
      fila(
        new ButtonBuilder()
          .setCustomId("fichaje:entrada:" + group)
          .setLabel("Entrada")
          .setEmoji(emojiBoton("ENTRADA"))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("fichaje:salida:" + group)
          .setLabel("Salida")
          .setEmoji(emojiBoton("SALIDA"))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("fichaje:activos:" + group)
          .setLabel("Activos")
          .setEmoji(emojiBoton("ACTIVOS"))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fichaje:mias:" + group)
          .setLabel("Mis horas")
          .setEmoji(emojiBoton("HORAS"))
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fichaje:admin:" + group)
          .setLabel("Administración")
          .setEmoji(emojiBoton("ADMIN"))
          .setStyle(ButtonStyle.Primary),
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* Respuestas de entrada y salida                                             */
/* -------------------------------------------------------------------------- */

export function avisoEntrada(
  rank: string,
  name: string,
  desde: Date,
  discordUserId?: string | undefined,
) {
  const hora = localDateTime(desde).split(" ")[1] ?? "";

  return new ContainerBuilder()
    .setAccentColor(COLOR.entrada)
    .addTextDisplayComponents(
      texto(
        "### " +
          emoji("ENTRADA") +
          " Fichaje abierto\n" +
          emoji("EXITO") +
          " Tu entrada quedó registrada, " +
          (discordUserId ? "<@" + discordUserId + "> " : "") +
          etiqueta(rank, name) +
          ".\n\n" +
          emoji("RELOJ") +
          " Desde las **" +
          hora +
          "**. El tiempo se cuenta solo hasta que le des a **Salida**.",
      ),
    );
}

export function avisoSalida(resultado: CloseResult) {
  const contenedor = new ContainerBuilder()
    .setAccentColor(COLOR.salida)
    .addTextDisplayComponents(
      texto(
        "### " +
          emoji("SALIDA") +
          " Fichaje cerrado\n" +
          etiqueta(resultado.member.rank, resultado.member.name) +
          "\n\n" +
          emoji("RELOJ") +
          " **Duración:** `" +
          resultado.duration +
          "`\n-# " +
          localDateTime(resultado.startedAt) +
          " → " +
          localDateTime(resultado.endedAt),
      ),
    );

  if (resultado.applied.length > 1) {
    contenedor
      .addSeparatorComponents(separador())
      .addTextDisplayComponents(
        texto(
          "-# El turno cruzó la medianoche, así que se repartió por día:\n" +
            resultado.applied
              .map((d) => "-# · " + d.workDate + ": `" + formatDuration(d.seconds) + "`")
              .join("\n"),
        ),
      );
  }

  if (resultado.skipped.length > 0) {
    contenedor
      .addSeparatorComponents(separador())
      .addTextDisplayComponents(
        texto(
          emoji("ERROR") +
            " **" +
            resultado.skipped.join(", ") +
            "** no entra en ningún período abierto, así que ese tiempo no se cargó a la planilla. " +
            "Avisale a un administrador para que lo cargue a mano.",
        ),
      );
  }

  return contenedor;
}

/** El registro que va al canal del bloque cada vez que alguien cierra. */
export function registroFichaje(resultado: CloseResult) {
  const automatico = resultado.reason === "automatico";
  const forzado = resultado.reason === "forzado";
  const fecha = localDateTime(resultado.endedAt).split(" ")[0] ?? "";

  return new ContainerBuilder()
    .setAccentColor(automatico ? COLOR.aviso : GROUP_COLOR[resultado.member.group])
    .addTextDisplayComponents(
      texto(
        "### " +
          emoji("FICHAJE") +
          " Fichaje cerrado\n" +
          emoji("STAFF") +
          " **Staff**\n" +
          etiqueta(resultado.member.rank, resultado.member.name) +
          (resultado.member.discordUserId ? " <@" + resultado.member.discordUserId + ">" : "") +
          "\n\n" +
          emoji("CALENDARIO") +
          " **Fecha**\n" +
          fecha +
          "\n\n" +
          emoji("RELOJ") +
          " **Horas totales**\n`" +
          resultado.duration +
          "`",
      ),
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        "-# " +
          localDateTime(resultado.startedAt) +
          " → " +
          localDateTime(resultado.endedAt) +
          (automatico
            ? "\n-# " +
              emoji("ERROR") +
              " Cierre automático del sistema. Este tiempo puede no ser real: conviene revisarlo."
            : "") +
          (forzado ? "\n-# " + emoji("ADMIN") + " Cerrado por un administrador." : ""),
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* Listados                                                                   */
/* -------------------------------------------------------------------------- */

export function listaActivos(activos: readonly ActiveShift[], titulo: string, color: number) {
  const contenedor = new ContainerBuilder().setAccentColor(color);

  if (activos.length === 0) {
    return contenedor.addTextDisplayComponents(
      texto("### " + emoji("ACTIVOS") + " " + titulo + "\nNo hay nadie fichado en este momento."),
    );
  }

  return contenedor
    .addTextDisplayComponents(texto("### " + emoji("ACTIVOS") + " " + titulo))
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        activos
          .map(
            (a) =>
              "· " +
              etiqueta(a.rank, a.name) +
              " — `" +
              formatDuration(a.seconds) +
              "`" +
              (a.discordUserId ? " <@" + a.discordUserId + ">" : ""),
          )
          .join("\n"),
      ),
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto("-# " + activos.length + (activos.length === 1 ? " activo" : " activos")),
    );
}

/* -------------------------------------------------------------------------- */
/* Reportes diarios                                                           */
/* -------------------------------------------------------------------------- */

export function reporteDiario(input: {
  readonly titulo: string;
  readonly fecha: string;
  readonly lineas: readonly DailyLine[];
  readonly color: number;
  readonly global?: boolean;
}) {
  const legible = fechaLegible(input.fecha);

  const contenedor = new ContainerBuilder()
    .setAccentColor(input.color)
    .addTextDisplayComponents(
      texto(
        "## " +
          (input.global ? emoji("GLOBAL") : emoji("REPORTE")) +
          " " +
          input.titulo +
          "\nActividad del día **" +
          legible +
          "**.",
      ),
    )
    .addSeparatorComponents(separador());

  if (input.lineas.length === 0) {
    return contenedor.addTextDisplayComponents(
      texto("Nadie fichó en todo el día.\n-# Si eso no es lo esperado, revisá los paneles."),
    );
  }

  const total = input.lineas.reduce((suma, l) => suma + l.seconds, 0);

  /**
   * Discord corta un bloque de texto a los 4000 caracteres. Con cuarenta
   * personas alcanza de sobra, pero si algún día no alcanzara es mejor partir
   * en varios bloques que perder la cola del listado sin avisar.
   */
  const lineas = input.lineas.map(
    (l) => "· " + etiqueta(l.rank, l.name) + ": `" + formatDuration(l.seconds) + "`",
  );

  for (const bloque of partirEnBloques(lineas, 3500)) {
    contenedor.addTextDisplayComponents(texto(bloque));
  }

  return contenedor
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        "-# " +
          input.lineas.length +
          (input.lineas.length === 1 ? " persona" : " personas") +
          " · total `" +
          formatDuration(total) +
          "`",
      ),
    );
}

function partirEnBloques(lineas: readonly string[], maximo: number): string[] {
  const bloques: string[] = [];
  let actual = "";

  for (const linea of lineas) {
    if (actual.length + linea.length + 1 > maximo) {
      bloques.push(actual);
      actual = linea;
    } else {
      actual = actual.length > 0 ? actual + "\n" + linea : linea;
    }
  }

  if (actual.length > 0) bloques.push(actual);
  return bloques;
}

/* -------------------------------------------------------------------------- */
/* Estado del período                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cómo viene el período, sin abrir la página.
 *
 * Contesta las tres preguntas que se hacen mirando la planilla: cuánto se
 * acumuló, de dónde salen esas horas, y quién todavía no cargó nada. Lo último
 * es lo que más se usa: es la lista de a quién hay que ir a buscar antes de que
 * el período cierre.
 *
 * La barra de reparto se dibuja con bloques de texto porque Discord no deja
 * meter una imagen sin subir un archivo. Veinte bloques alcanzan para ver de un
 * vistazo si el peso de las horas está en High o en Low.
 *
 * Los números salen de la misma consulta que usa la pantalla de períodos. Que
 * el bot y la web cuenten distinto sería peor que no tener bot: la primera vez
 * que no coinciden, nadie vuelve a creerle a ninguno de los dos.
 */
export function estadoPeriodo(datos: PeriodOverview) {
  const contenedor = new ContainerBuilder()
    .setAccentColor(COLOR.imperial)
    .addTextDisplayComponents(
      texto(
        "## " +
          emoji("CALENDARIO") +
          " Período " +
          fechaLegible(datos.startDate) +
          " → " +
          fechaLegible(datos.endDate) +
          "\n" +
          emoji("RELOJ") +
          " `" +
          formatMinutes(datos.totalMinutes) +
          "` acumuladas · " +
          emoji("DINERO") +
          " **" +
          formatMoney(datos.totalAmount) +
          "** generados",
      ),
    )
    .addSeparatorComponents(separador());

  /**
   * El aviso va arriba de todo cuando corresponde: si hoy no entra en este
   * período, cualquier número de abajo se lee mal. Alguien mira "0h acumuladas"
   * y concluye que no fichó nadie, cuando lo que pasa es que las horas de hoy
   * no tienen dónde caer.
   */
  if (!datos.cubreHoy) {
    contenedor
      .addTextDisplayComponents(
        texto(
          emoji("ERROR") +
            " **Hoy no entra en este período.** Lo que se fiche hoy se cierra bien, pero no queda " +
            "cargado en ninguna planilla. Se arregla en la página, en **Períodos**.",
        ),
      )
      .addSeparatorComponents(separador());
  }

  if (datos.totalMinutes <= 0) {
    return contenedor.addTextDisplayComponents(
      texto(
        "Todavía no hay ni una hora cargada en este período.\n-# Los **" +
          datos.memberCount +
          "** miembros ya están en la planilla, esperando el primer fichaje.",
      ),
    );
  }

  const reparto = datos.groups.map((grupo) => {
    const porcion = grupo.minutes / datos.totalMinutes;
    // Al menos un bloque lleno: un grupo con pocas horas igual tiene que verse.
    const llenos = Math.max(1, Math.min(20, Math.round(porcion * 20)));

    return (
      "**" +
      grupo.label +
      "** · `" +
      formatMinutes(grupo.minutes) +
      "` · " +
      formatMoney(grupo.amount) +
      "\n`" +
      "█".repeat(llenos) +
      "░".repeat(20 - llenos) +
      "` " +
      Math.round(porcion * 100) +
      "% · " +
      grupo.members +
      (grupo.members === 1 ? " persona" : " personas")
    );
  });

  contenedor.addTextDisplayComponents(texto(reparto.join("\n\n")));

  if (datos.top.length > 0) {
    const puestos = ["🥇", "🥈", "🥉"];

    contenedor
      .addSeparatorComponents(separador())
      .addTextDisplayComponents(
        texto(
          "**Más horas**\n" +
            datos.top
              .map(
                (persona, indice) =>
                  (puestos[indice] ?? "·") +
                  " " +
                  etiqueta(persona.rank, persona.name) +
                  " · `" +
                  formatMinutes(persona.minutes) +
                  "`",
              )
              .join("\n"),
        ),
      );
  }

  contenedor.addSeparatorComponents(separador());

  if (datos.totalSinCargar === 0) {
    contenedor.addTextDisplayComponents(
      texto(emoji("EXITO") + " Los **" + datos.memberCount + "** cargaron horas en este período."),
    );
  } else {
    const restantes = datos.totalSinCargar - datos.sinCargar.length;

    contenedor.addTextDisplayComponents(
      texto(
        "**Sin cargar todavía** · " +
          datos.totalSinCargar +
          " de " +
          datos.memberCount +
          "\n" +
          datos.sinCargar.map((persona) => "· " + etiqueta(persona.rank, persona.name)).join("\n") +
          (restantes > 0 ? "\n-# y " + restantes + " más." : ""),
      ),
    );
  }

  return contenedor;
}

/* -------------------------------------------------------------------------- */
/* Tabla de horas                                                             */
/* -------------------------------------------------------------------------- */

/**
 * La tabla del período, de mayor a menor.
 *
 * Los tres primeros llevan medalla y el resto va numerado. No lleva importes a
 * propósito: la ve cualquiera del staff, y cuánto cobra cada uno no es
 * información de vestuario. Las horas sí — son públicas entre compañeros y son
 * justamente lo que la tabla premia.
 *
 * La barra de cada fila es proporcional al primero, no al total: contra el
 * total las barras quedarían todas pegadas a cero y no se compararía nada.
 */
export function tablaHoras(datos: {
  readonly startDate: string;
  readonly endDate: string;
  readonly total: number;
  readonly filas: readonly { name: string; rank: string; minutes: number }[];
}) {
  const contenedor = new ContainerBuilder()
    .setAccentColor(COLOR.imperial)
    .addTextDisplayComponents(
      texto(
        "## " +
          emoji("HORAS") +
          " Tabla de horas\n" +
          emoji("CALENDARIO") +
          " Período " +
          fechaLegible(datos.startDate) +
          " → " +
          fechaLegible(datos.endDate),
      ),
    )
    .addSeparatorComponents(separador());

  if (datos.filas.length === 0) {
    return contenedor.addTextDisplayComponents(
      texto("Todavía no hay horas cargadas en este período.\n-# El primero que fiche encabeza."),
    );
  }

  const puestos = ["🥇", "🥈", "🥉"];
  const mayor = datos.filas[0]?.minutes ?? 1;

  const lineas = datos.filas.map((fila, indice) => {
    const llenos = Math.max(1, Math.min(12, Math.round((fila.minutes / mayor) * 12)));

    return (
      (puestos[indice] ?? "`" + String(indice + 1).padStart(2, " ") + "`") +
      " " +
      etiqueta(fila.rank, fila.name) +
      "\n-# `" +
      "█".repeat(llenos) +
      "░".repeat(12 - llenos) +
      "` " +
      formatMinutes(fila.minutes)
    );
  });

  return contenedor
    .addTextDisplayComponents(texto(lineas.join("\n")))
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(texto("-# Total del período: `" + formatMinutes(datos.total) + "`"));
}

/**
 * El período de la semana se abrió solo.
 *
 * Se anuncia en vez de hacerlo callado: que aparezca un período que nadie creó
 * tiene que ser una noticia, no un misterio. Y si el rango salió recortado por
 * pisar a otro, hay que decirlo — alguien va a mirar esas fechas raras y
 * merece saber por qué son así.
 */
export function periodoAbiertoSolo(
  semana: {
    readonly startDate: string;
    readonly endDate: string;
  },
  recortado: boolean,
) {
  return new ContainerBuilder()
    .setAccentColor(COLOR.entrada)
    .addTextDisplayComponents(
      texto(
        "## " +
          emoji("CALENDARIO") +
          " Se abrió el período de esta semana\n**" +
          fechaLegible(semana.startDate) +
          "** → **" +
          fechaLegible(semana.endDate) +
          "**",
      ),
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        (recortado
          ? "El rango salió recortado para no pisar otro período que ya existía. Si no es el que " +
            "corresponde, se corrige en la página.\n\n"
          : "") +
          "Todo el staff activo entra en cero y los fichajes de hoy ya tienen dónde anotarse.\n" +
          "-# Se abre solo cuando el día de hoy no cae adentro de ningún período.",
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* Alarma: hoy no entra en ningún período                                     */
/* -------------------------------------------------------------------------- */

/**
 * El aviso de que las horas de hoy no tienen dónde anotarse.
 *
 * Pasa cuando el período de esta semana se borró, o cuando el siguiente se creó
 * arrancando más adelante. Un fichaje se anota en el período que CONTIENE el
 * día trabajado: sin uno que cubra hoy, quien cierre su turno recibe un aviso y
 * nadie más se entera. Después alguien reclama su sueldo y la hora no está.
 *
 * Se manda una vez por día, no cada diez minutos: una alarma que se repite sin
 * parar se silencia, y una alarma silenciada no sirve para nada.
 */
export function sinPeriodoParaHoy(
  hoy: string,
  proximo: { readonly startDate: string; readonly endDate: string } | null,
) {
  /**
   * El período abierto puede haber quedado atrás o no haber empezado todavía,
   * y no es lo mismo: uno se cierra, el otro se corrige o se espera. Decir
   * "el más próximo" para los dos casos obliga a mirar las fechas y deducirlo.
   */
  const cuerpo = !proximo
    ? "No hay ningún período abierto."
    : (proximo.endDate < hoy
        ? "El único período abierto (**" +
          fechaLegible(proximo.startDate) +
          "** → **" +
          fechaLegible(proximo.endDate) +
          "**) ya terminó"
        : "El período abierto (**" +
          fechaLegible(proximo.startDate) +
          "** → **" +
          fechaLegible(proximo.endDate) +
          "**) todavía no empezó") +
      ", y hoy es **" +
      fechaLegible(hoy) +
      "**.";

  return new ContainerBuilder()
    .setAccentColor(COLOR.imperial)
    .addTextDisplayComponents(
      texto("## " + emoji("ERROR") + " Las horas de hoy no tienen dónde anotarse\n" + cuerpo),
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        "Un fichaje se anota en el período que **contiene el día trabajado**. Mientras siga así, " +
          "todo lo que se fiche hoy se cierra bien pero no queda cargado en ninguna planilla.\n\n" +
          "Se arregla en la página, en **Períodos**: creando uno que incluya hoy, o corrigiendo " +
          "las fechas del que está abierto.\n" +
          "-# Este aviso se manda una vez por día mientras el problema siga.",
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* Mensajes sueltos                                                           */
/* -------------------------------------------------------------------------- */

export function aviso(titulo: string, cuerpo: string, color: number = COLOR.neutro) {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(texto("### " + titulo + "\n" + cuerpo));
}

/**
 * El mensaje de "no podés".
 *
 * Dice **sin permiso**, que es lo que la persona necesita entender, y recién
 * después explica el motivo. Antes decía "no estás vinculado" para todo, que a
 * un moderador que se equivocó de panel no le explicaba nada.
 */
export function sinPermiso(motivo: string) {
  return aviso(emoji("DENEGADO") + " No tenés permiso", motivo, COLOR.imperial);
}

export function error(cuerpo: string) {
  return aviso(emoji("ERROR") + " No se pudo", cuerpo, COLOR.imperial);
}

/* -------------------------------------------------------------------------- */
/* Cierre de período                                                          */
/* -------------------------------------------------------------------------- */

/**
 * El aviso del sábado, cuando se cierra un período y arranca el siguiente.
 *
 * Es el momento en que todo el staff quiere saber su número, y hasta ahora la
 * rotación pasaba en silencio: había que entrar a la página a buscarlo.
 */
export function avisoCierrePeriodo(input: {
  readonly cerrado: { readonly code: string; readonly minutes: number; readonly amount: number };
  readonly abierto: { readonly startDate: string; readonly endDate: string };
  readonly lineas: readonly {
    readonly name: string;
    readonly rank: string;
    readonly minutes: number;
    readonly amount: number;
  }[];
}) {
  const contenedor = new ContainerBuilder()
    .setAccentColor(COLOR.imperial)
    .addTextDisplayComponents(
      texto(
        "## " +
          emoji("IMPERIO") +
          " Período cerrado · " +
          input.cerrado.code.replaceAll("_", " → ") +
          "\nQuedó congelado: horas, rangos y tarifas de este período ya no cambian.",
      ),
    )
    .addSeparatorComponents(separador());

  if (input.lineas.length === 0) {
    contenedor.addTextDisplayComponents(texto("Nadie cargó horas en este período."));
  } else {
    const filas = input.lineas.map(
      (l) =>
        "· " +
        etiqueta(l.rank, l.name) +
        " — `" +
        formatMinutes(l.minutes) +
        "` → **" +
        formatMoney(l.amount) +
        "**",
    );

    for (const bloque of partirEnBloques(filas, 3500)) {
      contenedor.addTextDisplayComponents(texto(bloque));
    }
  }

  return contenedor
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        emoji("DINERO") +
          " **Total a pagar:** " +
          formatMoney(input.cerrado.amount) +
          "\n" +
          emoji("RELOJ") +
          " **Horas totales:** " +
          formatMinutes(input.cerrado.minutes) +
          "\n\n-# El período nuevo va del " +
          input.abierto.startDate +
          " al " +
          input.abierto.endDate +
          ". Todos arrancan en cero.",
      ),
    );
}
