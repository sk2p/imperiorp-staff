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
