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
import type { ActiveShift, CloseResult, DailyLine } from "@/server/shifts";

/**
 * IMPERIO RP — Las pantallas del bot.
 *
 * Todo se arma con Components V2: contenedores con filo de color, texto,
 * separadores y —esto es lo que no se podía con los embeds viejos— los botones
 * adentro del mismo bloque, no colgando abajo. Un panel es una sola pieza.
 *
 * Una regla del formato que conviene tener presente: con Components V2 el
 * mensaje NO puede llevar `content` ni `embeds`. Todo es componentes, o Discord
 * rechaza el mensaje.
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
        "## 🕒 Fichaje · " +
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
          .setEmoji("🟢")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("fichaje:salida:" + group)
          .setLabel("Salida")
          .setEmoji("🔴")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("fichaje:activos:" + group)
          .setLabel("Activos")
          .setEmoji("👥")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fichaje:mias:" + group)
          .setLabel("Mis horas")
          .setEmoji("📊")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("fichaje:admin:" + group)
          .setLabel("Administración")
          .setEmoji("⚙️")
          .setStyle(ButtonStyle.Primary),
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* Respuestas de entrada y salida                                             */
/* -------------------------------------------------------------------------- */

export function avisoEntrada(rank: string, name: string, desde: Date) {
  return new ContainerBuilder()
    .setAccentColor(COLOR.entrada)
    .addTextDisplayComponents(
      texto(
        "### 🟢 Fichaje abierto\n" +
          etiqueta(rank, name) +
          "\nEntrada registrada a las **" +
          localDateTime(desde).split(" ")[1] +
          "**.\n\n-# Acordate de darle a **Salida** cuando termines, o el tiempo se sigue contando.",
      ),
    );
}

export function avisoSalida(resultado: CloseResult) {
  const contenedor = new ContainerBuilder()
    .setAccentColor(COLOR.salida)
    .addTextDisplayComponents(
      texto(
        "### 🔴 Fichaje cerrado\n" +
          etiqueta(resultado.member.rank, resultado.member.name) +
          "\n**Duración:** `" +
          resultado.duration +
          "`\n" +
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
          "⚠️ **" +
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

  const contenedor = new ContainerBuilder()
    .setAccentColor(automatico ? COLOR.aviso : GROUP_COLOR[resultado.member.group])
    .addTextDisplayComponents(
      texto(
        "### 📝 Fichaje cerrado\n" +
          "👤 **Staff**\n" +
          etiqueta(resultado.member.rank, resultado.member.name) +
          "\n\n📅 **Fecha**\n" +
          localDateTime(resultado.endedAt).split(" ")[0] +
          "\n\n⏱️ **Horas totales**\n`" +
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
            ? "\n-# ⚠️ Cerrado automáticamente: quedó abierto más de 12 horas. El tiempo puede no ser real."
            : "") +
          (forzado ? "\n-# ⚙️ Cerrado por un administrador." : ""),
      ),
    );

  return contenedor;
}

/* -------------------------------------------------------------------------- */
/* Listados                                                                   */
/* -------------------------------------------------------------------------- */

export function listaActivos(activos: readonly ActiveShift[], titulo: string, color: number) {
  const contenedor = new ContainerBuilder().setAccentColor(color);

  if (activos.length === 0) {
    return contenedor.addTextDisplayComponents(
      texto("### 👥 " + titulo + "\nNo hay nadie fichado en este momento."),
    );
  }

  return contenedor
    .addTextDisplayComponents(texto("### 👥 " + titulo))
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
        (input.global ? "## 🌎 " : "## 📊 ") +
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
   * personas eso alcanza de sobra, pero si algún día no alcanzara es mejor
   * partir en varios bloques que perder la cola del listado sin avisar.
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
/* Pagos                                                                      */
/* -------------------------------------------------------------------------- */

export function avisoPago(input: {
  readonly pagador: string;
  readonly staff: string;
  readonly rank: string;
  readonly monto: number;
  readonly periodo: string;
  readonly minutos: string;
  readonly anulado?: boolean;
  readonly motivo?: string | null;
}) {
  const contenedor = new ContainerBuilder()
    .setAccentColor(input.anulado ? COLOR.salida : COLOR.pago)
    .addTextDisplayComponents(
      texto(
        (input.anulado ? "### ❌ Pago anulado\n" : "### 💸 Pago registrado\n") +
          "👤 **Staff**\n" +
          etiqueta(input.rank, input.staff) +
          "\n\n💰 **Monto**\n`" +
          formatMoney(input.monto) +
          "`\n\n⏱️ **Horas del período**\n`" +
          input.minutos +
          "`",
      ),
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      texto(
        "-# " +
          (input.anulado ? "Anulado por" : "Registrado por") +
          " **" +
          input.pagador +
          "** · período " +
          input.periodo +
          " · " +
          localDateTime(new Date()) +
          (input.motivo ? "\n-# Motivo: " + input.motivo : ""),
      ),
    );

  return contenedor;
}

/* -------------------------------------------------------------------------- */
/* Mensajes sueltos                                                           */
/* -------------------------------------------------------------------------- */

export function aviso(titulo: string, cuerpo: string, color: number = COLOR.neutro) {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(texto("### " + titulo + "\n" + cuerpo));
}

export function error(cuerpo: string) {
  return aviso("⚠️ No se pudo", cuerpo, COLOR.imperial);
}
