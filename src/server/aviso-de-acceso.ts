import { getEnv } from "@/lib/core/env";
import { logger } from "@/lib/core/logger";
import { discordDeCuenta } from "./cuentas-discord";
import { describirNavegador, notifyNewBrowserLogin } from "./discord-notify";
import { enSegundoPlano } from "./segundo-plano";

/**
 * IMPERIO RP — Aviso de acceso desde un navegador nuevo.
 *
 * Quien tiene la contraseña de otro puede entrar sin que el dueño se entere
 * nunca: la sesión aparece en Mi cuenta, pero nadie mira esa lista si no
 * sospecha. Esto le escribe al dueño por privado en el momento en que alguien
 * entra desde un navegador que la cuenta no conocía.
 *
 * "Conocido" es el navegador que tiene la marca de un acceso anterior (ver
 * `lib/auth/dispositivo.ts`). También avisa la primera vez desde el navegador
 * de siempre después de cambiar la contraseña, porque cambiarla invalida las
 * marcas: es un aviso de más, y es preferible a uno de menos.
 */
export function avisarNavegadorNuevo(input: {
  readonly userId: string;
  readonly username: string;
  readonly ip: string;
  readonly userAgent: string | null;
  readonly lugar: string | null;
  readonly cuando: Date;
}): void {
  enSegundoPlano(async () => {
    try {
      const discordUserId = await discordDeCuenta(input.userId);

      if (!discordUserId) {
        // Queda igual en los eventos de seguridad, marcado como navegador nuevo.
        logger.info("Acceso desde un navegador nuevo, sin Discord vinculado para avisar", {
          username: input.username,
        });
        return;
      }

      await notifyNewBrowserLogin({
        discordUserId,
        username: input.username,
        navegador: describirNavegador(input.userAgent),
        ip: input.ip,
        lugar: input.lugar,
        cuando: input.cuando,
        urlCuenta: urlDeMiCuenta(),
      });
    } catch (error) {
      logger.warn("No se pudo avisar el acceso desde un navegador nuevo", { error });
    }
  });
}

/**
 * El enlace a Mi cuenta, sólo si la dirección configurada es la pública. Un
 * enlace a `localhost` en un privado de Discord no lleva a ningún lado.
 */
function urlDeMiCuenta(): string | null {
  const base = getEnv().APP_URL;
  if (!base.startsWith("https://")) return null;
  return new URL("/perfil", base).toString();
}
