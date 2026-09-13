import {
  notifyPayment,
  notifyPaymentsPrivately,
  type PaymentNotice,
  type PrivatePaymentNotice,
} from "./discord-notify";
import { enSegundoPlano } from "./segundo-plano";

/**
 * IMPERIO RP — Avisos de pago que esperan a que el pago exista.
 *
 * Un pago se registra adentro de una transacción, y los avisos a Discord
 * tienen que salir DESPUÉS de que esa transacción confirmó. Salían desde
 * adentro: si algo fallaba después, o la transacción serializable se
 * reintentaba por un conflicto, el canal anunciaba un pago que no existía, o
 * lo anunciaba dos veces.
 *
 * El uso es siempre el mismo:
 *
 *   const avisos = nuevosAvisos();
 *   const pago = await withSerializableTransaction(async (tx) => {
 *     avisos.vaciar();                       // un reintento arranca de cero
 *     …
 *     avisos.anotar(aviso, discordUserId);
 *   });
 *   avisos.enviar();                         // sólo se llega acá si confirmó
 *
 * Salen en segundo plano: la respuesta al navegador no espera a Discord. Ver
 * `segundo-plano.ts`.
 *
 * No va dentro de `discord-notify.ts` porque ese archivo también lo usa el bot,
 * y el bot no tiene Next.
 */
export function nuevosAvisos() {
  let paraElCanal: PaymentNotice[] = [];
  let paraCadaUno: PrivatePaymentNotice[] = [];

  return {
    vaciar(): void {
      paraElCanal = [];
      paraCadaUno = [];
    },

    /**
     * `alCanal: false` para los lotes: cuarenta pagos seguidos en el canal
     * tapan todo lo demás, y el lote ya queda entero en la auditoría. El
     * privado a cada persona sale igual.
     */
    anotar(
      aviso: PaymentNotice,
      discordUserId: string | null,
      opciones: { readonly alCanal?: boolean } = {},
    ): void {
      if (opciones.alCanal !== false) paraElCanal.push(aviso);
      if (discordUserId) paraCadaUno.push({ ...aviso, discordUserId });
    },

    enviar(): void {
      const canal = paraElCanal;
      const personas = paraCadaUno;
      if (canal.length === 0 && personas.length === 0) return;

      enSegundoPlano(async () => {
        for (const aviso of canal) await notifyPayment(aviso);
        await notifyPaymentsPrivately(personas);
      });
    },
  };
}
