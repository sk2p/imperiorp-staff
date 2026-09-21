import { logger } from "@/lib/core/logger";
import { localDateTime } from "@/domain/clock";
import { formatMoney } from "@/domain/money";
import { formatMinutes } from "@/domain/time";

/**
 * IMPERIO RP — Avisos de la página hacia Discord.
 *
 * Cuando alguien registra un pago en el panel, el canal de pagos se entera solo.
 *
 * Va directo a la API de Discord con el token del bot, y no a través del bot ni
 * de un webhook, por dos razones:
 *
 *   · La página vive en Vercel y el bot en otra máquina. No hay forma de que
 *     una llame a la otra, y armar una cola que el bot consulte cada minuto
 *     tendría a la base despierta las 24 horas para un mensaje que sucede una
 *     vez por semana.
 *   · Un webhook común de canal no admite Components V2. Con el token del bot
 *     sí, y el aviso sale con el mismo formato que todo lo demás.
 *
 * Nada de esto puede voltear un pago: el aviso se manda y si falla queda en el
 * log. Registrar el pago es lo importante; avisarlo es una cortesía.
 */

/* Tipos de componente de la API. Son los números que espera Discord. */
const CONTAINER = 17;
const TEXT_DISPLAY = 10;
const SEPARATOR = 14;
const IS_COMPONENTS_V2 = 1 << 15;

const VERDE = 0x2bf58a;
const ROJO = 0xff4d5e;
const AMARILLO = 0xe2f227;

/**
 * Nadie sale mencionado. El motivo de una anulación lo escribe una persona, y
 * un "@everyone" ahí notificaba al canal entero.
 */
const SIN_MENCIONES = { parse: [] as string[] };

export interface PaymentNotice {
  readonly staffName: string;
  readonly rank: string;
  readonly amount: number;
  readonly minutes: number;
  readonly period: string;
  readonly actor: string;
  readonly voided?: boolean;
  readonly reason?: string | null;
}

function contenedor(notice: PaymentNotice): unknown {
  const encabezado = notice.voided ? "### ❌ Pago anulado" : "### 💸 Pago registrado";

  return {
    type: CONTAINER,
    accent_color: notice.voided ? ROJO : VERDE,
    components: [
      {
        type: TEXT_DISPLAY,
        content:
          encabezado +
          "\n👤 **Staff**\n`[" +
          notice.rank +
          "]` **" +
          notice.staffName +
          "**\n\n💰 **Monto**\n`" +
          formatMoney(notice.amount) +
          "`\n\n⏱️ **Horas del período**\n`" +
          formatMinutes(notice.minutes) +
          "`",
      },
      { type: SEPARATOR, divider: true, spacing: 1 },
      {
        type: TEXT_DISPLAY,
        content:
          "-# " +
          (notice.voided ? "Anulado por" : "Registrado por") +
          " **" +
          notice.actor +
          "** · período " +
          notice.period +
          " · " +
          localDateTime(new Date()) +
          (notice.reason ? "\n-# Motivo: " + notice.reason : ""),
      },
    ],
  };
}

/**
 * Publica el aviso. No lanza nunca: el llamador está dentro del flujo de un
 * pago y un problema de Discord no puede hacerlo fallar.
 */
export async function notifyPayment(notice: PaymentNotice): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  const canal = process.env.DISCORD_PAGOS?.trim();

  // Sin configurar, simplemente no se avisa. No es un error.
  if (!token || !canal) return;

  try {
    const respuesta = await fetch("https://discord.com/api/v10/channels/" + canal + "/messages", {
      method: "POST",
      headers: {
        Authorization: "Bot " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        flags: IS_COMPONENTS_V2,
        components: [contenedor(notice)],
        allowed_mentions: SIN_MENCIONES,
      }),
      // Si Discord tarda, se abandona: nadie espera por un aviso.
      signal: AbortSignal.timeout(5000),
    });

    if (!respuesta.ok) {
      logger.warn("Discord rechazó el aviso de pago", {
        estado: respuesta.status,
        detalle: (await respuesta.text()).slice(0, 300),
      });
    }
  } catch (error) {
    logger.warn("No se pudo avisar el pago a Discord", { error });
  }
}

/* -------------------------------------------------------------------------- */
/* Privados                                                                   */
/* -------------------------------------------------------------------------- */

async function llamarDiscord(token: string, ruta: string, cuerpo: unknown): Promise<Response> {
  return fetch("https://discord.com/api/v10" + ruta, {
    method: "POST",
    headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Abre el privado con alguien y le manda un contenedor. `true` si llegó.
 *
 * No lanza nunca. Alguien con los privados cerrados, o que se fue del servidor,
 * no recibe el aviso y queda anotado en el log; lo que lo originó sigue igual.
 */
async function mandarPrivado(
  token: string,
  discordUserId: string,
  componente: unknown,
  que: string,
): Promise<boolean> {
  try {
    const chat = await llamarDiscord(token, "/users/@me/channels", {
      recipient_id: discordUserId,
    });

    if (!chat.ok) {
      logger.warn("No se pudo abrir el privado", { que, estado: chat.status });
      return false;
    }

    const { id } = (await chat.json()) as { id?: string };
    if (!id) return false;

    const mensaje = await llamarDiscord(token, "/channels/" + id + "/messages", {
      flags: IS_COMPONENTS_V2,
      components: [componente],
      allowed_mentions: SIN_MENCIONES,
    });

    if (!mensaje.ok) {
      logger.warn("Discord rechazó el privado", {
        que,
        estado: mensaje.status,
        detalle: (await mensaje.text()).slice(0, 200),
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.warn("No se pudo mandar el privado", { que, error });
    return false;
  }
}

export interface PrivatePaymentNotice extends PaymentNotice {
  /** La cuenta vinculada a la ficha. Sin vínculo no hay a quién escribirle. */
  readonly discordUserId: string;
}

/**
 * El mismo aviso, pero a la persona que cobró.
 *
 * "¿Ya me pagaron?" es la pregunta que más le llega a quien liquida, todas las
 * semanas, por privado y de a una. Con esto la respuesta le llega sola a cada
 * uno en el momento en que se registra el pago, y si se anula, también.
 */
function contenedorPrivado(notice: PaymentNotice): unknown {
  const cuerpo = notice.voided
    ? "### ❌ Se anuló un pago tuyo\nEl pago de `" +
      formatMoney(notice.amount) +
      "` del período **" +
      notice.period +
      "** quedó anulado."
    : "### 💸 Te pagaron\nYa tenés registrado el pago del período **" +
      notice.period +
      "**.\n\n💰 **Monto**\n`" +
      formatMoney(notice.amount) +
      "`" +
      (notice.minutes > 0
        ? "\n\n⏱️ **Horas del período**\n`" + formatMinutes(notice.minutes) + "`"
        : "");

  return {
    type: CONTAINER,
    accent_color: notice.voided ? ROJO : VERDE,
    components: [
      { type: TEXT_DISPLAY, content: cuerpo },
      { type: SEPARATOR, divider: true, spacing: 1 },
      {
        type: TEXT_DISPLAY,
        content:
          "-# " +
          (notice.voided ? "Anulado por" : "Registrado por") +
          " **" +
          notice.actor +
          "** · " +
          localDateTime(new Date()) +
          (notice.reason ? "\n-# Motivo: " + notice.reason : "") +
          "\n-# Si algo no coincide, hablalo con quien liquida.",
      },
    ],
  };
}

/**
 * Manda los avisos por privado, de a uno.
 *
 * De a uno y no todos juntos: "pagar todo" son cuarenta de golpe, y Discord
 * limita cuántos chats privados abre un bot por segundo. En fila tardan unos
 * segundos y llegan todos; en paralelo, la mitad rebota.
 */
export async function notifyPaymentsPrivately(
  notices: readonly PrivatePaymentNotice[],
): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token || notices.length === 0) return;

  for (const notice of notices) {
    await mandarPrivado(token, notice.discordUserId, contenedorPrivado(notice), "aviso de pago");
  }
}

/* -------------------------------------------------------------------------- */
/* Acceso desde un navegador nuevo                                            */
/* -------------------------------------------------------------------------- */

/**
 * "Chrome en Windows", a partir del user agent.
 *
 * No hace falta precisión, hace falta que la persona reconozca —o no— su
 * equipo de un vistazo. El orden importa: Edge y Opera se anuncian también
 * como Chrome, y Chrome como Safari; el iPhone dice "Mac OS X".
 */
export function describirNavegador(userAgent: string | null | undefined): string {
  if (!userAgent) return "Navegador desconocido";

  const navegador = /Edg(A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Otro navegador";

  const sistema = /iPhone|iPod/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(userAgent)
            ? "Mac"
            : /Linux/.test(userAgent)
              ? "Linux"
              : "otro sistema";

  return navegador + " en " + sistema;
}

export interface NewBrowserLoginNotice {
  readonly discordUserId: string;
  readonly username: string;
  readonly navegador: string;
  readonly ip: string | null;
  readonly lugar: string | null;
  readonly cuando: Date;
  /** Enlace a Mi cuenta. Nulo si la dirección pública no está configurada. */
  readonly urlCuenta: string | null;
}

/** Sólo caracteres de una IP: lo que venga en la cabecera no arma formato. */
const IP = /^[0-9a-fA-F:.]{3,45}$/;

function contenedorAcceso(aviso: NewBrowserLoginNotice): unknown {
  const desde =
    [aviso.lugar, aviso.ip && IP.test(aviso.ip) ? "IP `" + aviso.ip + "`" : null]
      .filter(Boolean)
      .join(" · ") || "Ubicación desconocida";

  return {
    type: CONTAINER,
    accent_color: AMARILLO,
    components: [
      {
        type: TEXT_DISPLAY,
        content:
          "### 🔐 Entraron a tu cuenta desde un navegador nuevo\n" +
          "👤 **Cuenta**\n`" +
          aviso.username +
          "`\n\n💻 **Navegador**\n" +
          aviso.navegador +
          "\n\n📍 **Desde**\n" +
          desde,
      },
      { type: SEPARATOR, divider: true, spacing: 1 },
      {
        type: TEXT_DISPLAY,
        content:
          "**¿Fuiste vos?** No hace falta hacer nada.\n" +
          "**¿No fuiste vos?** Entrá a " +
          (aviso.urlCuenta ? "[Mi cuenta](" + aviso.urlCuenta + ")" : "**Mi cuenta**") +
          " → **Sesiones activas**, cerrá la que no reconozcas y cambiá la contraseña.\n" +
          "-# " +
          localDateTime(aviso.cuando),
      },
    ],
  };
}

/** Le avisa al dueño de la cuenta que entraron desde un navegador nuevo. No lanza. */
export async function notifyNewBrowserLogin(aviso: NewBrowserLoginNotice): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) return;

  await mandarPrivado(token, aviso.discordUserId, contenedorAcceso(aviso), "aviso de acceso");
}
