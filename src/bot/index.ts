import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
  type UserSelectMenuInteraction,
} from "discord.js";

import { closeDatabase } from "@/db";
import { isAppError, isTransientDatabaseError } from "@/lib/core/errors";
import { logger } from "@/lib/core/logger";
import { formatDuration, localDate } from "@/domain/clock";
import { GROUP_DEFINITIONS, isStaffGroup, type StaffGroup } from "@/domain/groups";
import { RANK_DEFINITIONS, isStaffRank } from "@/domain/ranks";
import {
  closeShift,
  findMemberByDiscord,
  getOpenShift,
  linkDiscordAccount,
  listActiveShifts,
  listUnlinkedMembers,
  periodSummary,
  startShift,
  unlinkDiscordAccount,
  type ShiftMember,
} from "@/server/shifts";
import { notifyPayment } from "@/server/discord-notify";
import { COLOR, GROUP_COLOR, botConfig, groupChannels } from "./config";
import { emoji, revisarEmojis } from "./emojis";
import { startScheduler } from "./tasks";
import {
  aviso,
  avisoEntrada,
  avisoSalida,
  error as errorUi,
  etiqueta,
  sinPermiso,
  listaActivos,
  panelFichaje,
  registroFichaje,
} from "./ui";

/**
 * IMPERIO RP — Bot de fichajes.
 *
 * Trabaja contra la MISMA base que la página. No guarda nada propio y no
 * sincroniza nada: cuando alguien cierra un fichaje acá, esa hora ya está en la
 * planilla de /horas. Es la única forma de que los dos lados no se contradigan.
 *
 * Cada bloque de staff tiene su circuito separado —panel, registros y resumen—
 * y el bot no deja cruzarlos: el rango de la persona decide a qué panel puede
 * tocarle los botones, no el canal donde esté parada.
 */

const config = botConfig();

const client = new Client({
  // Sin intents privilegiados: el bot vive de interacciones, no lee mensajes.
  intents: [GatewayIntentBits.Guilds],
});

/** Desde ADM para arriba se considera administración del fichaje. */
const TIER_ADMIN = RANK_DEFINITIONS.ADM.tier;

function esAdministracion(member: ShiftMember | null): boolean {
  if (!member) return false;
  return isStaffRank(member.rank) && RANK_DEFINITIONS[member.rank].tier >= TIER_ADMIN;
}

/**
 * Quién puede administrar el fichaje.
 *
 * Normalmente se decide por el RANGO de la ficha, que es la jerarquía real de
 * Imperio RP y no un rol de Discord que cualquiera puede repartir.
 *
 * Pero hay un caso que esa regla sola no cubre: el primer día no hay ninguna
 * ficha vinculada, así que nadie tendría rango, así que nadie podría vincular a
 * nadie —ni a sí mismo. Para eso está la segunda puerta: quien administra el
 * servidor de Discord puede hacer el arranque. No es un agujero, es la única
 * forma de que el sistema pueda empezar.
 */
async function puedeAdministrar(
  interaction: RepliableInteraction,
): Promise<{ ok: boolean; member: ShiftMember | null }> {
  const member = await findMemberByDiscord(interaction.user.id);
  if (esAdministracion(member)) return { ok: true, member };

  const permisos = interaction.memberPermissions;
  const esDuenoDelServidor =
    permisos?.has(PermissionFlagsBits.ManageGuild) === true ||
    permisos?.has(PermissionFlagsBits.Administrator) === true;

  return { ok: esDuenoDelServidor, member };
}

/* -------------------------------------------------------------------------- */
/* Respuestas                                                                 */
/* -------------------------------------------------------------------------- */

/** Toda respuesta del bot es privada salvo que se diga lo contrario. */
async function responder(
  interaction: RepliableInteraction,
  contenedor: ContainerBuilder,
  extra: readonly ActionRowBuilder<MessageActionRowComponentBuilder>[] = [],
): Promise<void> {
  const components = [contenedor, ...extra];

  /**
   * La bandera de Components V2 va también al editar.
   *
   * Sin ella, Discord interpreta el mensaje con el formato viejo y rechaza un
   * contenedor: como toda respuesta pasa primero por `deferReply`, ésta es la
   * rama que se usa siempre. La de `reply` queda como respaldo para el caso en
   * que algo conteste sin haber diferido.
   */
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ components, flags: MessageFlags.IsComponentsV2 });
    return;
  }

  await interaction.reply({
    components,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

/** Manda un contenedor a un canal por id, si está configurado. */
async function publicar(channelId: string | null, contenedor: ContainerBuilder): Promise<void> {
  if (!channelId) return;

  try {
    const canal = await client.channels.fetch(channelId);
    if (!canal || !canal.isTextBased() || !("send" in canal)) {
      logger.warn("El canal configurado no sirve para publicar", { channelId });
      return;
    }

    await (canal as TextBasedChannel & { send: (options: unknown) => Promise<unknown> }).send({
      components: [contenedor],
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (error) {
    logger.error("No se pudo publicar en el canal", { channelId, error });
  }
}

/**
 * Quién es quien tocó el botón.
 *
 * Si la cuenta de Discord no está vinculada a ninguna ficha, no hay a quién
 * cargarle las horas: se explica y se corta ahí.
 */
async function requerirFicha(interaction: RepliableInteraction): Promise<ShiftMember | null> {
  const member = await findMemberByDiscord(interaction.user.id);
  if (member) return member;

  await responder(
    interaction,
    sinPermiso(
      "Tu cuenta de Discord no está vinculada a ninguna ficha del staff, así que el sistema no " +
        "sabe a quién cargarle las horas.\n\n" +
        "Pedile a un **ADM** que te vincule con `/vincular`. Si administrás este servidor de " +
        "Discord, podés hacerlo vos mismo.",
    ),
  );
  return null;
}

/* -------------------------------------------------------------------------- */
/* Botones del panel                                                          */
/* -------------------------------------------------------------------------- */

async function manejarBoton(interaction: ButtonInteraction): Promise<void> {
  const [, accion, valor] = interaction.customId.split(":");
  if (!accion) return;

  // Los paneles de administración usan su propio espacio de nombres.
  if (accion === "admin") return void (await panelAdministracion(interaction, valor));
  if (accion === "adminaccion") return void (await accionAdministracion(interaction, valor));

  const group = isStaffGroup(valor) ? valor : null;
  const member = await requerirFicha(interaction);
  if (!member) return;

  /**
   * El panel es de un bloque y la persona pertenece a otro.
   *
   * Se corta acá y no en el servidor porque el mensaje tiene que explicar qué
   * hacer: el circuito de cada bloque existe justamente para que los registros
   * no se mezclen.
   */
  if (group && member.group !== group) {
    await responder(
      interaction,
      sinPermiso(
        "Este panel es de **" +
          GROUP_DEFINITIONS[group].label +
          "** y vos sos " +
          etiqueta(member.rank, member.name) +
          ", de **" +
          GROUP_DEFINITIONS[member.group].label +
          "**.\n\nUsá el panel de tu categoría.",
      ),
    );
    return;
  }

  switch (accion) {
    case "entrada":
      return void (await accionEntrada(interaction, member));
    case "salida":
      return void (await accionSalida(interaction, member));
    case "activos":
      return void (await accionActivos(interaction, member.group));
    case "mias":
      return void (await accionMisHoras(interaction, member));
    default:
      return;
  }
}

async function accionEntrada(
  interaction: RepliableInteraction,
  member: ShiftMember,
): Promise<void> {
  const abierto = await getOpenShift(member.id);
  if (abierto) {
    await responder(
      interaction,
      errorUi(
        "Ya tenés un fichaje abierto desde hace `" +
          formatDuration(abierto.seconds) +
          "`.\n\nSi te olvidaste de cerrarlo, dale a **🔴 Salida**.",
      ),
    );
    return;
  }

  const resultado = await startShift({
    member,
    discordUserId: interaction.user.id,
    discordUsername: interaction.user.username,
  });

  await responder(
    interaction,
    avisoEntrada(member.rank, member.name, resultado.startedAt, interaction.user.id),
  );
}

async function accionSalida(interaction: RepliableInteraction, member: ShiftMember): Promise<void> {
  const abierto = await getOpenShift(member.id);
  if (!abierto) {
    await responder(
      interaction,
      errorUi("No tenés ningún fichaje abierto. Dale a **🟢 Entrada** para empezar."),
    );
    return;
  }

  const resultado = await closeShift({ staffMemberId: member.id });

  await responder(interaction, avisoSalida(resultado));
  // El registro del bloque, público, es el que queda como constancia.
  await publicar(groupChannels(member.group).registro, registroFichaje(resultado));
}

async function accionActivos(interaction: RepliableInteraction, group: StaffGroup): Promise<void> {
  const activos = await listActiveShifts(group);
  await responder(
    interaction,
    listaActivos(activos, "Fichados ahora · " + GROUP_DEFINITIONS[group].label, GROUP_COLOR[group]),
  );
}

async function accionMisHoras(
  interaction: RepliableInteraction,
  member: ShiftMember,
  /** Cuando un ADM consulta a otro, el texto habla de esa persona y no de "vos". */
  ajeno = false,
): Promise<void> {
  const resumen = await periodSummary(member.id);

  if (!resumen) {
    await responder(interaction, errorUi("No hay ningún período abierto en este momento."));
    return;
  }

  const abierto = await getOpenShift(member.id);
  const detalle =
    resumen.days.length > 0
      ? resumen.days
          .map((d) => "· " + d.workDate + ": `" + formatDuration(d.seconds) + "`")
          .join("\n")
      : ajeno
        ? "Todavía no tiene horas en este período."
        : "Todavía no cargaste horas en este período.";

  await responder(
    interaction,
    aviso(
      emoji("HORAS") +
        " " +
        (ajeno ? "Horas de " + member.name : "Tus horas") +
        " · " +
        resumen.weekLabel,
      etiqueta(member.rank, member.name) +
        (member.discordUserId ? " <@" + member.discordUserId + ">" : "") +
        "\n\n" +
        emoji("RELOJ") +
        " **Total del período:** `" +
        formatDuration(resumen.seconds) +
        "`\n\n" +
        detalle +
        (abierto
          ? "\n\n-# " +
            emoji("ENTRADA") +
            (ajeno ? " Tiene" : " Tenés") +
            " un fichaje abierto hace `" +
            formatDuration(abierto.seconds) +
            "`, todavía sin sumar."
          : ""),
      GROUP_COLOR[member.group],
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Administración                                                             */
/* -------------------------------------------------------------------------- */

async function panelAdministracion(
  interaction: ButtonInteraction,
  _valor: string | undefined,
): Promise<void> {
  const { ok } = await puedeAdministrar(interaction);
  if (!ok) {
    await responder(
      interaction,
      sinPermiso(
        "La administración del fichaje es de **ADM** para arriba, o de quien administre el " +
          "servidor de Discord.",
      ),
    );
    return;
  }

  const activos = await listActiveShifts();

  const contenedor = aviso(
    "⚙️ Administración del fichaje",
    "Fichajes abiertos ahora mismo: **" +
      activos.length +
      "**\n\nDesde acá podés cerrar el fichaje de alguien que se olvidó de salir, " +
      "o vincular una cuenta de Discord con su ficha del staff.",
    COLOR.imperial,
  );

  const acciones = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("fichaje:adminaccion:activos")
      .setLabel("Ver todos los activos")
      .setEmoji("👥")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("fichaje:adminaccion:cerrar")
      .setLabel("Cerrar un fichaje")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(activos.length === 0),
    new ButtonBuilder()
      .setCustomId("fichaje:adminaccion:vincular")
      .setLabel("Vincular cuenta")
      .setEmoji("🔗")
      .setStyle(ButtonStyle.Primary),
  );

  await responder(interaction, contenedor, [acciones]);
}

async function accionAdministracion(
  interaction: ButtonInteraction,
  accion: string | undefined,
): Promise<void> {
  const { ok } = await puedeAdministrar(interaction);
  if (!ok) {
    await responder(interaction, sinPermiso("Esto es de rango **ADM** para arriba."));
    return;
  }

  if (accion === "activos") {
    const activos = await listActiveShifts();
    await responder(
      interaction,
      listaActivos(activos, "Fichados ahora · todo el staff", COLOR.imperial),
    );
    return;
  }

  if (accion === "cerrar") {
    const activos = await listActiveShifts();
    if (activos.length === 0) {
      await responder(interaction, errorUi("No hay ningún fichaje abierto."));
      return;
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId("fichaje:cerrarsel")
      .setPlaceholder("Elegí a quién cerrarle el fichaje")
      .addOptions(
        activos.slice(0, 25).map((a) => ({
          label: (a.name + " [" + a.rank + "]").slice(0, 100),
          description: ("Abierto hace " + formatDuration(a.seconds)).slice(0, 100),
          value: a.staffMemberId,
        })),
      );

    await responder(
      interaction,
      aviso(
        "🔴 Cerrar un fichaje ajeno",
        "El tiempo se cuenta hasta este momento y queda marcado en el registro como cerrado por un administrador.",
        COLOR.salida,
      ),
      [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)],
    );
    return;
  }

  if (accion === "vincular") {
    await responder(
      interaction,
      aviso(
        "🔗 Vincular una cuenta",
        "Elegí primero la cuenta de Discord. Después vas a poder elegir a qué ficha del staff corresponde.",
        COLOR.imperial,
      ),
      [
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId("fichaje:vincularusuario")
            .setPlaceholder("Cuenta de Discord"),
        ),
      ],
    );
  }
}

async function manejarSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const { ok } = await puedeAdministrar(interaction);
  if (!ok) return;

  if (interaction.customId === "fichaje:cerrarsel") {
    const objetivo = interaction.values[0];
    if (!objetivo) return;

    const resultado = await closeShift({
      staffMemberId: objetivo,
      closedByDiscordId: interaction.user.id,
      reason: "forzado",
    });

    await responder(
      interaction,
      aviso(
        "🔴 Fichaje cerrado",
        "Le cerraste el fichaje a " +
          etiqueta(resultado.member.rank, resultado.member.name) +
          " con `" +
          resultado.duration +
          "`.",
        COLOR.salida,
      ),
    );

    await publicar(groupChannels(resultado.member.group).registro, registroFichaje(resultado));
    return;
  }

  if (interaction.customId.startsWith("fichaje:vincularficha:")) {
    const discordUserId = interaction.customId.split(":")[2];
    const staffMemberId = interaction.values[0];
    if (!discordUserId || !staffMemberId) return;

    const usuario = await client.users.fetch(discordUserId).catch(() => null);
    const vinculado = await linkDiscordAccount(
      staffMemberId,
      discordUserId,
      usuario?.username ?? null,
    );

    await responder(
      interaction,
      aviso(
        "🔗 Cuenta vinculada",
        "<@" +
          discordUserId +
          "> quedó vinculado a " +
          etiqueta(vinculado.rank, vinculado.name) +
          " (**" +
          GROUP_DEFINITIONS[vinculado.group].label +
          "**).\n\nYa puede fichar desde el panel de su categoría.",
        COLOR.entrada,
      ),
    );
  }
}

async function manejarUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
  const { ok } = await puedeAdministrar(interaction);
  if (!ok) return;

  const elegido = interaction.values[0];
  if (!elegido) return;

  const fichas = await listUnlinkedMembers(null, 25);
  if (fichas.length === 0) {
    await responder(interaction, errorUi("No hay fichas de staff cargadas en la página."));
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("fichaje:vincularficha:" + elegido)
    .setPlaceholder("Ficha del staff")
    .addOptions(
      fichas.map((f) => ({
        label: (f.name + " [" + f.rank + "]").slice(0, 100),
        description: (f.discordUserId
          ? "Ya vinculada · se reemplaza"
          : GROUP_DEFINITIONS[f.group].label
        ).slice(0, 100),
        value: f.id,
      })),
    );

  await responder(
    interaction,
    aviso(
      "🔗 Vincular <@" + elegido + ">",
      "Elegí la ficha del staff que le corresponde.\n\n-# Si la lista no la trae, usá `/vincular` que permite buscar por nombre.",
      COLOR.imperial,
    ),
    [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select)],
  );
}

/* -------------------------------------------------------------------------- */
/* Comandos                                                                   */
/* -------------------------------------------------------------------------- */

const comandos = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Publica el panel de fichaje de una categoría en este canal")
    .addStringOption((option) =>
      option
        .setName("categoria")
        .setDescription("Bloque de staff al que corresponde este canal")
        .setRequired(true)
        .addChoices(
          { name: "High Staff", value: "HIGH_STAFF" },
          { name: "Mid Staff", value: "MID_STAFF" },
          { name: "Low Staff", value: "LOW_STAFF" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("vincular")
    .setDescription("Vincula una cuenta de Discord con una ficha del staff")
    .addUserOption((option) =>
      option.setName("usuario").setDescription("Cuenta de Discord").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("staff")
        .setDescription("Nombre de la ficha en la página")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("desvincular")
    .setDescription("Quita el vínculo entre una cuenta de Discord y su ficha")
    .addUserOption((option) =>
      option.setName("usuario").setDescription("Cuenta de Discord").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("probar-pagos")
    .setDescription("Manda un aviso de prueba al canal de pagos para verificar la configuración"),
  new SlashCommandBuilder()
    .setName("mis-horas")
    .setDescription("Muestra tus horas del período en curso"),
  new SlashCommandBuilder()
    .setName("horas")
    .setDescription("Muestra las horas de otra persona en el período en curso")
    .addUserOption((option) =>
      option.setName("usuario").setDescription("De quién querés ver las horas").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("activos")
    .setDescription("Muestra quién está fichado en este momento"),
].map((c) => c.toJSON());

async function manejarComando(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "mis-horas") {
    const member = await requerirFicha(interaction);
    if (member) await accionMisHoras(interaction, member);
    return;
  }

  /**
   * Las horas de otro.
   *
   * Es de ADM para arriba: las horas de una persona son lo que va a cobrar, y
   * no tiene por qué estar a la vista de todo el staff. Quien administra ya las
   * ve en la página; esto le ahorra abrirla.
   */
  if (interaction.commandName === "horas") {
    const { ok } = await puedeAdministrar(interaction);
    if (!ok) {
      await responder(
        interaction,
        sinPermiso(
          "Ver las horas de otra persona es de **ADM** para arriba.\n\n" +
            "Las tuyas las tenés en `/mis-horas`.",
        ),
      );
      return;
    }

    const usuario = interaction.options.getUser("usuario", true);
    const objetivo = await findMemberByDiscord(usuario.id);

    if (!objetivo) {
      await responder(
        interaction,
        errorUi(
          "<@" +
            usuario.id +
            "> no está vinculado a ninguna ficha del staff, así que no tiene horas propias.\n\n" +
            "Vinculalo con `/vincular` y a partir de ahí van a contarse.",
        ),
      );
      return;
    }

    await accionMisHoras(interaction, objetivo, true);
    return;
  }

  if (interaction.commandName === "activos") {
    const member = await requerirFicha(interaction);
    if (member) await accionActivos(interaction, member.group);
    return;
  }

  const { ok } = await puedeAdministrar(interaction);
  if (!ok) {
    await responder(
      interaction,
      sinPermiso(
        "Este comando es de **ADM** para arriba, o de quien administre el servidor de Discord.",
      ),
    );
    return;
  }

  if (interaction.commandName === "probar-pagos") {
    /**
     * El aviso de pago lo manda la PÁGINA, no el bot, así que cuando no llega
     * no hay forma de saber desde Discord si falta el token, si el canal está
     * mal o si el bot no tiene permiso para escribir ahí. Esto manda uno de
     * prueba por exactamente el mismo camino.
     */
    if (!process.env.DISCORD_PAGOS?.trim()) {
      await responder(
        interaction,
        errorUi(
          "No hay `DISCORD_PAGOS` configurado.\n\n" +
            "Poné el id del canal de pagos en el `.env`, y también en Vercel para que ande en producción.",
        ),
      );
      return;
    }

    await notifyPayment({
      staffName: "Prueba de configuración",
      rank: "ADM++",
      amount: 1_000_000,
      minutes: 60,
      period: "prueba",
      actor: interaction.user.username,
    });

    await responder(
      interaction,
      aviso(
        "Aviso de prueba enviado",
        "Si no aparece nada en el canal de pagos, revisá que el bot esté en ese canal y tenga " +
          "permiso para escribir. El detalle del error queda en la consola donde corre el bot.",
        COLOR.entrada,
      ),
    );
    return;
  }

  if (interaction.commandName === "panel") {
    const valor = interaction.options.getString("categoria", true);
    if (!isStaffGroup(valor)) return;

    const canal = interaction.channel;
    if (!canal || !canal.isTextBased() || !("send" in canal)) {
      await responder(interaction, errorUi("Acá no puedo publicar un panel."));
      return;
    }

    await (canal as TextBasedChannel & { send: (options: unknown) => Promise<unknown> }).send({
      components: [panelFichaje(valor)],
      flags: MessageFlags.IsComponentsV2,
    });

    await responder(
      interaction,
      aviso(
        "✅ Panel publicado",
        "El panel de **" +
          GROUP_DEFINITIONS[valor].label +
          "** quedá fijo en este canal. Los botones siguen funcionando aunque el bot se reinicie.",
        COLOR.entrada,
      ),
    );
    return;
  }

  if (interaction.commandName === "vincular") {
    const usuario = interaction.options.getUser("usuario", true);
    const staffMemberId = interaction.options.getString("staff", true);

    const vinculado = await linkDiscordAccount(staffMemberId, usuario.id, usuario.username);
    await responder(
      interaction,
      aviso(
        "🔗 Cuenta vinculada",
        "<@" +
          usuario.id +
          "> quedó vinculado a " +
          etiqueta(vinculado.rank, vinculado.name) +
          " (**" +
          GROUP_DEFINITIONS[vinculado.group].label +
          "**).",
        COLOR.entrada,
      ),
    );
    return;
  }

  if (interaction.commandName === "desvincular") {
    const usuario = interaction.options.getUser("usuario", true);
    const quitados = await unlinkDiscordAccount(usuario.id);

    await responder(
      interaction,
      quitados > 0
        ? aviso("🔗 Vínculo quitado", "<@" + usuario.id + "> ya no está vinculado a ninguna ficha.")
        : errorUi("Esa cuenta no estaba vinculada a ninguna ficha."),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Arranque                                                                   */
/* -------------------------------------------------------------------------- */

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    /**
     * Discord da TRES SEGUNDOS para contestar, y después muestra "la
     * aplicación no responde" sin importar lo que pase después. Una base
     * dormida tarda más que eso en despertar.
     *
     * Diferir la respuesta compra quince minutos y se ve como "pensando…".
     * Hay que hacerlo antes de tocar la base, no después: si la consulta
     * tarda, ya es tarde para avisar que se está pensando.
     */
    if (
      (interaction.isChatInputCommand() ||
        interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isUserSelectMenu()) &&
      !interaction.deferred &&
      !interaction.replied
    ) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    if (interaction.isChatInputCommand()) return void (await manejarComando(interaction));
    if (interaction.isButton()) return void (await manejarBoton(interaction));
    if (interaction.isStringSelectMenu()) return void (await manejarSelect(interaction));
    if (interaction.isUserSelectMenu()) return void (await manejarUserSelect(interaction));

    if (interaction.isAutocomplete()) {
      const escrito = interaction.options.getFocused().toLowerCase();
      const fichas = await listUnlinkedMembers(escrito || null, 25);
      await interaction.respond(
        fichas.map((f) => ({ name: (f.name + " · " + f.rank).slice(0, 100), value: f.id })),
      );
    }
  } catch (error) {
    /**
     * Un error nunca deja la interacción colgada.
     *
     * Discord muestra "la aplicación no responde" si no se contesta, y el
     * usuario no sabe si fichó o no. Los errores de dominio llevan mensaje
     * propio; el resto sale genérico y queda completo en el log.
     */
    /**
     * Un corte de conexión no es un error del programa. El plan gratuito de la
     * base la duerme cuando nadie la usa, y quien ficha a las cuatro de la
     * mañana suele ser el que la despierta. Decirle "algo falló" por eso lo
     * deja sin saber si su entrada quedó registrada; decirle que reintente es
     * exacto, porque la transacción se deshizo entera.
     */
    const pasajero = isTransientDatabaseError(error);

    if (pasajero) logger.warn("La base no respondió durante una interacción");
    else logger.error("Error atendiendo una interacción", { error });

    if (interaction.isRepliable()) {
      const mensaje = pasajero
        ? "La base tardó en responder y no se guardó nada. Probá de nuevo en unos segundos."
        : isAppError(error)
          ? error.message
          : "Algo falló de este lado. Probá de nuevo; si sigue, avisale a pit o mati.";

      await responder(interaction, errorUi(mensaje)).catch(() => undefined);
    }
  }
});

client.once(Events.ClientReady, async (listo) => {
  logger.info("Bot de fichajes conectado", { usuario: listo.user.tag, dia: localDate() });

  /**
   * Un emoji mal configurado no rompe nada, pero Discord muestra el texto
   * crudo `<:NOMBRE:123>` y queda feo sin que nadie entienda por qué. Sólo
   * pasa al cambiar la configuración, así que se avisa al arrancar.
   */
  const emojis = await revisarEmojis(async (id) => {
    // Primero los de la aplicación: son los que viajan con el bot.
    try {
      const propio = await listo.application.emojis.fetch(id);
      if (propio) return { animated: propio.animated === true, origen: "aplicación" };
    } catch {
      // No es de la aplicación; se prueba con los del servidor.
    }

    const delServidor = listo.emojis.cache.get(id);
    return delServidor ? { animated: delServidor.animated === true, origen: "servidor" } : null;
  });

  if (emojis.rotos.length > 0) {
    logger.warn("Hay emojis personalizados que el bot no puede usar", {
      rotos: emojis.rotos.map((r) => r.key + ": " + r.motivo),
    });
  } else if (emojis.ok.length > 0) {
    logger.info("Emojis personalizados verificados", { cantidad: emojis.ok.length });
  }

  startScheduler(client, publicar);
});

async function registrarComandos(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.token);

  const ruta = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(ruta, { body: comandos });
  logger.info("Comandos registrados", {
    alcance: config.guildId ? "servidor " + config.guildId : "global",
    cantidad: comandos.length,
  });
}

async function main(): Promise<void> {
  await registrarComandos();
  await client.login(config.token);
}

/** Cierre ordenado: la base no queda con conexiones colgadas. */
for (const senal of ["SIGINT", "SIGTERM"] as const) {
  process.on(senal, () => {
    logger.info("Apagando el bot", { senal });
    void client
      .destroy()
      .then(() => closeDatabase())
      .finally(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  logger.error("No se pudo arrancar el bot", { error });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
