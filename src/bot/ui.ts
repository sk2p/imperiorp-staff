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
import { COLOR, GROUP_COLOR } from "./config";
import { emoji, emojiBoton } from "./emojis";
import type { ActiveShift, CloseResult, DailyLine } from "@/server/shifts";

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
      texto(
        "-# El fichaje se cierra solo si queda abierto más de 12 horas. " +
          "Si te olvidaste de salir, avisale a un administrador para que lo corrija.",
      ),
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
              " Cerrado automáticamente: quedó abierto más de 12 horas. El tiempo puede no ser real."
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
  const [anio, mes, dia] = input.fecha.split("-");
  const legible = dia + "/" + mes + "/" + anio;

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
