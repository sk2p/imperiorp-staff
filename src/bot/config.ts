import { GROUP_DEFINITIONS, STAFF_GROUPS, type StaffGroup } from "@/domain/groups";

/**
 * IMPERIO RP — Configuración del bot de fichajes.
 *
 * Los canales se declaran por variable de entorno y no en la base, porque el
 * bot se prueba en un servidor de Discord y después se muda al de verdad:
 * cambiar un `.env` es cambiar de servidor sin tocar una línea ni migrar nada.
 *
 * Cada bloque de staff —High, Mid y Low— tiene su propio circuito: su panel,
 * su canal de registros y su resumen diario. No se mezclan: un soporte no ve
 * los fichajes de los administradores.
 */

export interface GroupChannels {
  readonly group: StaffGroup;
  readonly label: string;
  /** Dónde se publica cada fichaje cerrado. */
  readonly registro: string | null;
  /** Dónde se publica el resumen de cada día. */
  readonly resumen: string | null;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

const SUFIJO: Readonly<Record<StaffGroup, string>> = {
  HIGH_STAFF: "HIGH",
  MID_STAFF: "MID",
  LOW_STAFF: "LOW",
};

export function groupChannels(group: StaffGroup): GroupChannels {
  const sufijo = SUFIJO[group];
  return {
    group,
    label: GROUP_DEFINITIONS[group].label,
    registro: env("DISCORD_REGISTRO_" + sufijo),
    resumen: env("DISCORD_RESUMEN_" + sufijo),
  };
}

export function allGroupChannels(): readonly GroupChannels[] {
  return STAFF_GROUPS.map(groupChannels);
}

export interface BotConfig {
  readonly token: string;
  readonly clientId: string;
  /** Con guild definido los comandos aparecen al instante; sin él tardan una hora. */
  readonly guildId: string | null;
  readonly resumenGlobal: string | null;
  readonly pagos: string | null;
}

export function botConfig(): BotConfig {
  const token = env("DISCORD_TOKEN");
  const clientId = env("DISCORD_CLIENT_ID");

  if (!token || !clientId) {
    throw new Error(
      "Faltan DISCORD_TOKEN y/o DISCORD_CLIENT_ID. Copiá .env.example y completá los valores del bot.",
    );
  }

  return {
    token,
    clientId,
    guildId: env("DISCORD_GUILD_ID"),
    resumenGlobal: env("DISCORD_RESUMEN_GLOBAL"),
    pagos: env("DISCORD_PAGOS"),
  };
}

/** La página en producción. Es la que hay que vigilar salvo que se diga otra. */
const PAGINA_PREDETERMINADA = "https://imperiorp-staff.vercel.app";

/**
 * Qué dirección vigila el bot, o `null` si la vigilancia está apagada.
 *
 * Tiene valor por defecto a propósito: una vigilancia que hay que acordarse de
 * configurar es una vigilancia que no está. `URL_PAGINA` la cambia —si la página
 * se muda de dominio— y `URL_PAGINA=no` la apaga, por ejemplo en un bot de
 * prueba que no tiene por qué mandarle privados a nadie.
 */
export function urlPaginaVigilada(): string | null {
  const valor = env("URL_PAGINA");
  if (valor?.toLowerCase() === "no") return null;
  return (valor ?? PAGINA_PREDETERMINADA).replace(/\/+$/, "");
}

/* -------------------------------------------------------------------------- */
/* Colores                                                                    */
/* -------------------------------------------------------------------------- */

/** El filo de color de cada contenedor. Es lo que se lee antes que el texto. */
export const COLOR = {
  imperial: 0xe5162c,
  entrada: 0x2bf58a,
  salida: 0xff4d5e,
  aviso: 0xe2f227,
  neutro: 0x6f747d,
  reporte: 0x38bdf8,
  pago: 0x2bf58a,
} as const;

export const GROUP_COLOR: Readonly<Record<StaffGroup, number>> = {
  HIGH_STAFF: 0xe5162c,
  MID_STAFF: 0x34d399,
  LOW_STAFF: 0x38bdf8,
};
