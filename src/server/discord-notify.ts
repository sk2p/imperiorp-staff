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
