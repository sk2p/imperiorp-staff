import { inArray } from "drizzle-orm";

import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { logger } from "@/lib/core/logger";

/**
 * IMPERIO RP — La bitácora que se ve en Discord.
 *
 * Todo lo que pasa en el panel ya queda en la base: la auditoría encadenada por
 * hash y los eventos de seguridad. El problema de un registro que vive en la
 * base es que sólo existe para quien se acuerde de ir a mirarlo, y nadie entra
 * a la auditoría un martes a la tarde porque sí. Esto lo lleva a donde la gente
 * ya está: un canal de Discord.
 *
 * Cuatro decisiones que hacen que esto no moleste ni rompa nada:
 *
 *   1. NUNCA lanza y nunca hace esperar a nadie. Que Discord esté caído no
 *      puede impedir que alguien cargue sus horas. Todo va detrás de un
 *      `catch` que como mucho escribe en el log del servidor.
 *
 *   2. Se manda en tandas. Discord tolera cinco pedidos cada dos segundos por
 *      webhook; cerrar un período escribe cuarenta entradas de auditoría de un
 *      saque. Una tanda cada dos segundos convierte esas cuarenta en un
 *      mensaje.
 *
 *   3. Antes de mandar se comprueba que la entrada EXISTA en la base. La
 *      auditoría se escribe adentro de una transacción que todavía puede
 *      revertirse: sin esta comprobación, un pago que falló al final se
 *      anunciaría en Discord como si se hubiera hecho. Es una consulta por
 *      tanda, no por entrada.
 *
 *   4. Va por webhook y no por el bot. Un webhook es una URL: funciona desde
 *      Vercel sin mantener una conexión abierta, y si se filtra sólo permite
 *      escribir en ese canal — no leer, no borrar, no tocar el servidor.
 */

/** Cuánto se espera para juntar entradas antes de mandar la tanda. */
const TANDA_MS = 2000;

/** Tope de entradas por mensaje. Discord corta un mensaje a los 2000 caracteres. */
const MAX_POR_TANDA = 18;

/**
 * Tope de la cola.
 *
 * Si Discord no responde, la cola no puede crecer para siempre: sería
 * convertir una caída de Discord en una caída de memoria del servidor. Al
 * llenarse se descartan las más viejas y se anota cuántas se perdieron.
 */
const MAX_COLA = 400;

const COLOR = {
  normal: 0x6f747d,
  dinero: 0x2bf58a,
  peligro: 0xe5162c,
  aviso: 0xe2f227,
} as const;

/** Qué acciones merecen destacarse y de qué color. */
function colorDe(accion: string): number {
  if (accion.startsWith("PAYMENT")) return COLOR.dinero;
  if (accion.includes("DELETED") || accion.includes("VOIDED") || accion.includes("REOPENED")) {
    return COLOR.peligro;
  }
  if (accion.startsWith("USER") || accion.startsWith("WEEK_CLOSED")) return COLOR.aviso;
  return COLOR.normal;
}

interface Anotacion {
  readonly id: string;
  readonly accion: string;
  readonly actor: string;
  readonly resumen: string;
  readonly motivo: string | null;
}

let cola: Anotacion[] = [];
let descartadas = 0;
let temporizador: ReturnType<typeof setTimeout> | null = null;

function webhook(): string | null {
  const url = process.env.DISCORD_LOG_WEBHOOK?.trim();
  if (!url) return null;

  // Sólo webhooks de Discord: la variable podría quedar mal cargada y esto
  // manda datos internos a donde apunte.
  if (!/^https:\/\/(canary\.|ptb\.)?discord\.com\/api\/webhooks\//.test(url)) {
    logger.warn("DISCORD_LOG_WEBHOOK no parece un webhook de Discord: se ignora");
    return null;
  }

  return url;
}

/**
 * Anota una entrada de auditoría para mandarla a Discord.
 *
 * Se llama después de escribirla en la base. No espera: encola y vuelve.
 */
export function anotarEnBitacora(entrada: Anotacion): void {
  if (!webhook()) return;

  if (cola.length >= MAX_COLA) {
    cola.shift();
    descartadas += 1;
  }

  cola.push(entrada);

  if (temporizador) return;
  temporizador = setTimeout(() => {
    temporizador = null;
    void vaciar();
  }, TANDA_MS);

  // No sostiene el proceso vivo: si Node quiere terminar, que termine.
  temporizador.unref?.();
}

async function vaciar(): Promise<void> {
  const url = webhook();
  if (!url || cola.length === 0) return;

  const tanda = cola.slice(0, MAX_POR_TANDA);
  cola = cola.slice(MAX_POR_TANDA);
  const perdidas = descartadas;
  descartadas = 0;

  try {
    /**
     * Sólo se anuncia lo que quedó realmente escrito.
     *
     * La auditoría se escribe adentro de la transacción de la operación. Si esa
     * transacción se revierte —un error al final, un choque de versión—, la
     * entrada nunca existió. Anunciarla igual sería contar en Discord un pago
     * que no se hizo.
     */
    const existentes = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        inArray(
          auditLogs.id,
          tanda.map((a) => a.id),
        ),
      );

    const confirmadas = new Set(existentes.map((fila) => fila.id));
    const reales = tanda.filter((a) => confirmadas.has(a.id));
    if (reales.length === 0) return;

    const lineas = reales.map(
      (a) =>
        "**" +
        a.actor +
        "** · " +
        escapar(a.resumen) +
        (a.motivo ? "\n-# motivo: " + escapar(a.motivo) : ""),
    );

    const cuerpo = {
      username: "Imperio RP · Bitácora",
      embeds: [
        {
          color: colorDe(reales[0]?.accion ?? ""),
          description: lineas.join("\n").slice(0, 4000),
          footer: {
            text:
              reales.length +
              (reales.length === 1 ? " movimiento" : " movimientos") +
              (perdidas > 0 ? " · " + perdidas + " sin registrar por saturación" : ""),
          },
          timestamp: new Date().toISOString(),
        },
      ],
      // Aunque alguien escriba "@everyone" en un motivo, no suena para nadie.
      allowed_mentions: { parse: [] as string[] },
    };

    const respuesta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(8000),
    });

    if (!respuesta.ok) {
      logger.warn("La bitácora de Discord rechazó la tanda", {
        estado: respuesta.status,
        entradas: reales.length,
      });
    }
  } catch (error) {
    logger.warn("No se pudo mandar la tanda a la bitácora de Discord", { error });
  } finally {
    // Si quedaron entradas, se programa la siguiente tanda.
    if (cola.length > 0 && !temporizador) {
      temporizador = setTimeout(() => {
        temporizador = null;
        void vaciar();
      }, TANDA_MS);
      temporizador.unref?.();
    }
  }
}

/**
 * Un evento de seguridad, que va solo y sin esperar la tanda.
 *
 * Un intento de acceso fallido puede esperar dos segundos; una cuenta bloqueada
 * o un rechazo por origen es justo lo que alguien quiere ver AHORA. Además no
 * pasan por la auditoría, así que no hay nada que confirmar contra la base.
 */
export function avisarSeguridad(input: {
  readonly tipo: string;
  readonly etiqueta: string;
  readonly severidad: string;
  readonly usuario?: string | null;
  readonly ip?: string | null;
  readonly detalle?: string | null;
}): void {
  const url = webhook();
  if (!url) return;

  const grave = input.severidad === "critical" || input.severidad === "high";

  const cuerpo = {
    username: "Imperio RP · Seguridad",
    embeds: [
      {
        color: grave ? COLOR.peligro : COLOR.aviso,
        title: input.etiqueta,
        description: [
          input.usuario ? "**Usuario:** " + escapar(input.usuario) : null,
          input.ip ? "**Origen:** `" + escapar(input.ip) + "`" : null,
          input.detalle ? escapar(input.detalle) : null,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 2000),
        footer: { text: input.tipo + " · " + input.severidad },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };

  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(8000),
  }).catch((error: unknown) => {
    logger.warn("No se pudo avisar del evento de seguridad", { error });
  });
}

/**
 * Neutraliza el formato de Discord.
 *
 * El nombre de una ficha, un motivo escrito a mano: todo eso lo escribe una
 * persona y termina adentro de un mensaje. Sin escapar, alguien que se llame
 * `||spoiler||` o escriba un enlace deja la bitácora hecha un desastre — y en
 * un registro de auditoría, poder falsear cómo se lee lo que hiciste no es un
 * problema estético.
 */
function escapar(texto: string): string {
  return texto.replace(/[\\*_~`|>[\]()@#]/g, (caracter) => "\\" + caracter).slice(0, 500);
}
