import { after } from "next/server";

import {
  notifyPayment,
  notifyPaymentsPrivately,
  type PaymentNotice,
  type PrivatePaymentNotice,
} from "./discord-notify";

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
 * Salen con `after`: la respuesta al navegador no espera a Discord, y la
 * función tampoco se corta antes de mandarlos, que es lo que le puede pasar en
 * Vercel a una promesa suelta.
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

/**
 * `after` sólo funciona dentro de un pedido. Fuera de uno —un script, un
 * test— lanza, y ahí alcanza con dispararlo suelto.
 */
function enSegundoPlano(tarea: () => Promise<void>): void {
  try {
    after(tarea);
  } catch {
    void tarea();
  }
}
