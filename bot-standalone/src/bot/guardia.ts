import { RANK_DEFINITIONS, isStaffRank } from "@/domain/ranks";

/**
 * IMPERIO RP — Las reglas de acceso del bot, sin Discord adentro.
 *
 * Viven aparte de `index.ts` para poder probarlas. Ese archivo se conecta a
 * Discord apenas se importa, así que lo que queda ahí adentro no lo cubre
 * ningún test, y una regla de permisos sin test es una regla que se rompe sin
 * que nadie se entere. Ver `tests/seguridad-bot.test.ts`.
 */

/** Desde ADM para arriba se considera administración del fichaje. */
const TIER_ADMIN = RANK_DEFINITIONS.ADM.tier;

export function esAdministracion(member: { readonly rank: string } | null): boolean {
  if (!member) return false;
  return isStaffRank(member.rank) && RANK_DEFINITIONS[member.rank].tier >= TIER_ADMIN;
}

/**
 * Quién puede administrar el fichaje.
 *
 * Normalmente decide el RANGO de la ficha, que es la jerarquía real de Imperio
 * RP y no un rol de Discord que cualquiera puede repartir.
 *
 * La excepción es el primer día: sin ninguna ficha vinculada nadie tendría
 * rango, y nadie podría vincular a nadie. Para eso, quien administra el
 * servidor de Discord puede hacer el arranque. Esa puerta se cierra sola en
 * cuanto hay un ADM vinculado: administrar un servidor de Discord no es ser ADM
 * del staff, y con la puerta abierta para siempre cualquiera con permisos de
 * Discord podría ver lo que cobra otro o apuntar fichajes ajenos a su ficha.
 *
 * `hayAdministracionVinculada` llega como función y no como valor para no
 * consultar la base cuando no hace falta: a un ADM se lo reconoce sin más.
 */
export async function decidirAdministracion(entrada: {
  readonly member: { readonly rank: string } | null;
  readonly hayAdministracionVinculada: () => Promise<boolean>;
  readonly gestionaServidor: boolean;
}): Promise<boolean> {
  if (esAdministracion(entrada.member)) return true;
  if (await entrada.hayAdministracionVinculada()) return false;
  return entrada.gestionaServidor;
}

/**
 * ¿La interacción viene de otro servidor de Discord?
 *
 * Si el bot termina agregado a otro servidor —por error, o porque la aplicación
 * quedó pública—, ahí también le llegan los clics. Cada acción pide ficha y
 * rango, pero la puerta de arranque de arriba mira los permisos de Discord del
 * servidor DONDE SE HACE CLIC, y en un servidor propio cualquiera es
 * administrador.
 *
 * Los privados no tienen servidor y pasan: por ahí llegan los recordatorios de
 * fichaje largo. Sin `DISCORD_GUILD_ID` configurado no se filtra nada.
 */
export function esDeOtroServidor(
  guildId: string | null,
  servidorConfigurado: string | null,
): boolean {
  return servidorConfigurado !== null && guildId !== null && guildId !== servidorConfigurado;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Identificador de ficha del staff.
 *
 * La opción `staff` de `/vincular` se completa eligiendo de la lista, pero
 * Discord deja escribir cualquier texto y mandarlo igual. Sin comprobarlo, eso
 * llegaba a la base como identificador y la respuesta era un "algo falló".
 */
export function esIdDeFicha(valor: string | null | undefined): valor is string {
  return typeof valor === "string" && UUID.test(valor);
}

/** Identificador de cuenta de Discord: sólo dígitos, de 17 a 20. */
export function esIdDeDiscord(valor: string | null | undefined): valor is string {
  return typeof valor === "string" && SNOWFLAKE.test(valor);
}

/**
 * Menciones que el bot deja sonar: sólo personas.
 *
 * Hoy ningún texto del bot puede traer un `@everyone`: los nombres de las fichas
 * no admiten `@`. Pero ese cuidado vive en otro archivo, en la validación de la
 * página, y el día que se afloje, un nombre así en el canal de registros
 * notificaría al servidor entero. Esto lo corta del lado de Discord, pase lo
 * que pase antes.
 */
export const MENCIONES_PERMITIDAS: { parse: "users"[]; repliedUser: boolean } = {
  parse: ["users"],
  repliedUser: false,
};

/**
 * Freno del autocompletado de `/vincular`.
 *
 * Discord lo dispara con cada tecla, así que el tope es más alto que el de los
 * botones: sesenta por minuto es escribir un nombre largo varias veces.
 */
export const FRENO_AUTOCOMPLETADO = { maximo: 60, ventanaMs: 60_000 } as const;
