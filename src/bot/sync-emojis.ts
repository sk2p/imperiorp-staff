import { readFileSync, writeFileSync } from "node:fs";

import { EMOJI_DEFAULTS, type EmojiKey } from "./emojis";

/**
 * IMPERIO RP — Sincronizar los emojis del bot con el `.env`.
 *
 * Los identificadores de los emojis los inventa Discord al subirlos, así que
 * copiarlos a mano de la pantalla del portal es tedioso y con veintitrés es
 * cuestión de tiempo que se escape un dígito —y el error se ve recién al
 * arrancar, como un emoji que "no existe".
 *
 * Esto se los pregunta a Discord: lee los emojis de la APLICACIÓN, los empareja
 * por nombre con las claves que usa el bot y reescribe el `.env`. Si mañana
 * cambian un ícono, se vuelve a correr y listo.
 *
 *   pnpm bot:emojis
 */

interface ApplicationEmoji {
  readonly id: string;
  readonly name: string;
  readonly animated?: boolean;
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim();
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();

  if (!token || !clientId) {
    throw new Error("Faltan DISCORD_TOKEN y DISCORD_CLIENT_ID en el .env.");
  }

  const respuesta = await fetch(
    "https://discord.com/api/v10/applications/" + clientId + "/emojis",
    { headers: { Authorization: "Bot " + token } },
  );

  if (!respuesta.ok) {
    throw new Error(
      "Discord respondió " + respuesta.status + ": " + (await respuesta.text()).slice(0, 200),
    );
  }

  const cuerpo = (await respuesta.json()) as { items?: readonly ApplicationEmoji[] };
  const emojis = cuerpo.items ?? [];

  console.log("\nEmojis en la aplicación: " + emojis.length + "\n");

  /**
   * Se emparejan por nombre, sin distinguir mayúsculas y tolerando que el
   * nombre lleve o no el prefijo `EMOJI_`: al subirlos, Discord a veces recorta
   * o cambia caracteres, y obligar a una coincidencia exacta haría fallar la
   * sincronización por una tontería.
   */
  const porNombre = new Map<string, ApplicationEmoji>();
  for (const emoji of emojis) {
    const limpio = emoji.name.toUpperCase().replace(/^EMOJI_/, "");
    porNombre.set(limpio, emoji);
  }

  let env = readFileSync(".env", "utf8");
  const puestos: string[] = [];
  const faltantes: EmojiKey[] = [];

  for (const key of Object.keys(EMOJI_DEFAULTS) as EmojiKey[]) {
    const encontrado = porNombre.get(key);

    if (!encontrado) {
      faltantes.push(key);
      continue;
    }

    const codigo =
      "<" + (encontrado.animated ? "a" : "") + ":" + encontrado.name + ":" + encontrado.id + ">";
    const linea = "EMOJI_" + key + "=" + codigo;
    const patron = new RegExp("^EMOJI_" + key + "=.*$", "m");

    env = patron.test(env) ? env.replace(patron, linea) : env + "\n" + linea;
    puestos.push(key + " → " + codigo);
  }

  writeFileSync(".env", env, "utf8");

  for (const linea of puestos) console.log("  ✓ " + linea);

  if (faltantes.length > 0) {
    console.log("\n  Sin emoji en la aplicación (se usa el común):");
    for (const key of faltantes) {
      console.log("    · EMOJI_" + key + "  (hoy: " + EMOJI_DEFAULTS[key] + ")");
    }
    console.log(
      "\n  Para personalizarlos, subilos al portal de desarrolladores → tu aplicación →\n" +
        "  Emojis, con ese mismo nombre, y volvé a correr este comando.",
    );
  }

  console.log("\n.env actualizado. Reiniciá el bot y volvé a publicar los paneles.\n");
}

void main().catch((error: unknown) => {
  console.error("\n" + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exit(1);
});
