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
/* Aviso por privado                                                          */
/* -------------------------------------------------------------------------- */

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

async function llamarDiscord(token: string, ruta: string, cuerpo: unknown): Promise<Response> {
  return fetch("https://discord.com/api/v10" + ruta, {
    method: "POST",
    headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(5000),
  });
}

/**
 * Manda los avisos por privado, de a uno.
 *
 * De a uno y no todos juntos: "pagar todo" son cuarenta de golpe, y Discord
 * limita cuántos chats privados abre un bot por segundo. En fila tardan unos
 * segundos y llegan todos; en paralelo, la mitad rebota.
 *
 * No lanza nunca. Alguien con los privados cerrados, o que se fue del servidor,
 * no recibe el aviso y queda anotado en el log; el pago sigue registrado igual.
 */
export async function notifyPaymentsPrivately(
  notices: readonly PrivatePaymentNotice[],
): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token || notices.length === 0) return;

  for (const notice of notices) {
    try {
      const chat = await llamarDiscord(token, "/users/@me/channels", {
        recipient_id: notice.discordUserId,
      });

      if (!chat.ok) {
        logger.warn("No se pudo abrir el privado para avisar un pago", { estado: chat.status });
        continue;
      }

      const { id } = (await chat.json()) as { id?: string };
      if (!id) continue;

      const mensaje = await llamarDiscord(token, "/channels/" + id + "/messages", {
        flags: IS_COMPONENTS_V2,
        components: [contenedorPrivado(notice)],
      });

      if (!mensaje.ok) {
        logger.warn("Discord rechazó el aviso privado de pago", {
          estado: mensaje.status,
          detalle: (await mensaje.text()).slice(0, 200),
        });
      }
    } catch (error) {
      logger.warn("No se pudo avisar el pago por privado", { error });
    }
  }
}
