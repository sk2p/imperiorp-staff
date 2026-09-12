import { parseEmoji, type ComponentEmojiResolvable } from "discord.js";

/**
 * IMPERIO RP — Los emojis del bot, en un solo lugar.
 *
 * Arrancan como emojis comunes de Unicode, para que todo funcione desde el
 * minuto cero. Cuando suban los personalizados de Imperio RP, no hay que tocar
 * una línea de código: se pega el `<:nombre:id>` en el `.env` y el bot lo toma.
 *
 * Están todos acá y no repartidos por el código justamente para eso: cambiar la
 * cara del bot tiene que ser cambiar una lista, no buscar por veinte archivos.
 */

/** Cada clave es una variable `EMOJI_<CLAVE>` en el `.env`. */
export const EMOJI_DEFAULTS = {
  /* Acciones del panel */
  ENTRADA: "🟢",
  SALIDA: "🔴",
  ACTIVOS: "👥",
  HORAS: "📊",
  ADMIN: "⚙️",
  VINCULAR: "🔗",

  /* Estados */
  EXITO: "✅",
  ERROR: "⚠️",
  DENEGADO: "⛔",
  INFO: "ℹ️",

  /* Registros de fichaje */
  FICHAJE: "📝",
  RELOJ: "⏱️",
  CALENDARIO: "📅",
  STAFF: "👤",

  /* Reportes */
  REPORTE: "📊",
  GLOBAL: "🌎",

  /* Pagos */
  PAGO: "💸",
  DINERO: "💰",
  ANULADO: "❌",

  /* Categorías de staff */
  HIGH: "👑",
  MID: "🛡️",
  LOW: "🎧",

  /* Marca */
  IMPERIO: "🏛️",
} as const;

export type EmojiKey = keyof typeof EMOJI_DEFAULTS;

/**
 * El emoji listo para meter en un texto.
 *
 * Sirve igual para un emoji de Unicode (`🟢`) que para uno personalizado
 * (`<:entrada:123456789012345678>`): los dos se escriben igual dentro de un
 * mensaje.
 */
export function emoji(key: EmojiKey): string {
  const personalizado = process.env["EMOJI_" + key]?.trim();
  return personalizado && personalizado.length > 0 ? personalizado : EMOJI_DEFAULTS[key];
}

/**
 * El emoji para el `setEmoji` de un botón.
 *
 * Un botón no acepta el texto `<:nombre:id>`: necesita el id, el nombre y si es
 * animado, por separado. `parseEmoji` hace esa traducción; si lo que hay es un
 * emoji común, se devuelve tal cual.
 */
export function emojiBoton(key: EmojiKey): ComponentEmojiResolvable {
  const crudo = emoji(key);
  const analizado = parseEmoji(crudo);

  if (analizado?.id) {
    return { id: analizado.id, name: analizado.name, animated: analizado.animated ?? false };
  }

  return crudo;
}

/** Los que quedaron sin personalizar. Lo informa el arranque, como referencia. */
export function emojisSinPersonalizar(): readonly EmojiKey[] {
  return (Object.keys(EMOJI_DEFAULTS) as EmojiKey[]).filter(
    (key) => !process.env["EMOJI_" + key]?.trim(),
  );
}

/**
 * Revisa que los emojis personalizados existan y que el bot pueda usarlos.
 *
 * Un emoji mal configurado no rompe nada: Discord muestra el texto crudo
 * `<:NOMBRE:123>` y queda feo sin que nadie entienda por qué. Como sólo pasa al
 * cambiar la configuración, conviene enterarse al arrancar y no por una captura
 * de alguien del staff.
 *
 * Las tres causas posibles son: el id está mal, el bot no está en el servidor
 * que tiene ese emoji, o el emoji es animado y falta la `a` en `<a:`.
 */
export function revisarEmojis(existe: (id: string) => { animated: boolean } | null): {
  readonly ok: readonly EmojiKey[];
  readonly rotos: readonly { key: EmojiKey; motivo: string }[];
} {
  const ok: EmojiKey[] = [];
  const rotos: { key: EmojiKey; motivo: string }[] = [];

  for (const key of Object.keys(EMOJI_DEFAULTS) as EmojiKey[]) {
    const crudo = process.env["EMOJI_" + key]?.trim();
    if (!crudo || crudo.length === 0) continue;

    const analizado = parseEmoji(crudo);
    if (!analizado?.id) {
      // Es un emoji común de Unicode: no hay nada que verificar.
      ok.push(key);
      continue;
    }

    const encontrado = existe(analizado.id);
    if (!encontrado) {
      rotos.push({
        key,
        motivo: "no existe o el bot no está en el servidor que lo tiene",
      });
      continue;
    }

    if (encontrado.animated && !analizado.animated) {
      rotos.push({ key, motivo: "es animado: el código tiene que empezar con <a: y no con <:" });
      continue;
    }

    ok.push(key);
  }

  return { ok, rotos };
}
