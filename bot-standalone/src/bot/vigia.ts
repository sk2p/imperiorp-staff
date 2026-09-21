/**
 * IMPERIO RP — El bot vigila la página.
 *
 * Si Vercel o la base se caen, hoy la primera noticia es alguien del staff
 * quejándose de que no puede cargar horas. El bot está prendido las
 * veinticuatro horas en otra máquina: es el lugar natural para mirar y avisar.
 *
 * Qué mira, y por qué no siempre lo mismo:
 *
 *   · `/api/health` dice si la página está en pie. No toca la base.
 *   · `/api/ready` dice además si la base responde.
 *
 * Mirar la base cada cinco minutos la tendría despierta las veinticuatro horas,
 * y el plan gratuito de Neon se mide por tiempo despierta: la vigilancia sola
 * se comería el cupo del mes. Por eso el chequeo completo va cada diez minutos,
 * en el mismo momento en que el bot ya despierta la base con su revisión de
 * fichajes, y los del medio sólo miran la página.
 *
 * Un fallo suelto no avisa —un pedido que se corta pasa—: se vuelve a probar al
 * minuto, y recién con dos seguidos sale el privado. Se avisa una vez por caída,
 * no cada cinco minutos, y otra vez cuando vuelve, con cuánto duró.
 *
 * Esta parte no sabe nada de Discord, para poder probarla sola
 * (`tests/vigia.test.ts`). Lo que manda los privados está en `tasks.ts`.
 */

export interface EstadoVigia {
  /** Fallos seguidos desde el último chequeo bueno. */
  readonly fallos: number;
  /** Desde cuándo falla, si está fallando. */
  readonly desde: Date | null;
  /** Si esta caída ya se avisó. */
  readonly avisada: boolean;
}

export const ESTADO_VIGIA_INICIAL: EstadoVigia = { fallos: 0, desde: null, avisada: false };

/** Con cuántos fallos seguidos se avisa. */
export const FALLOS_PARA_AVISAR = 2;

export type Chequeo = { readonly ok: true } | { readonly ok: false; readonly motivo: string };

export type Decision =
  | { readonly tipo: "nada" }
  | { readonly tipo: "reintentar" }
  | { readonly tipo: "avisar-caida"; readonly desde: Date; readonly motivo: string }
  | { readonly tipo: "avisar-vuelta"; readonly desde: Date; readonly duracionMs: number };

export function evaluarChequeo(
  estado: EstadoVigia,
  chequeo: Chequeo,
  contexto: { readonly ahora: Date; readonly profundo: boolean },
): { readonly estado: EstadoVigia; readonly decision: Decision } {
  if (chequeo.ok) {
    /**
     * Con una caída ya avisada, sólo el chequeo completo puede decir que volvió.
     * `/api/health` responde aunque la base siga caída: si se lo diera por
     * bueno, llegaría "volvió" con la base todavía sin andar.
     */
    if (estado.avisada && !contexto.profundo) return { estado, decision: { tipo: "nada" } };

    if (estado.avisada && estado.desde) {
      return {
        estado: ESTADO_VIGIA_INICIAL,
        decision: {
          tipo: "avisar-vuelta",
          desde: estado.desde,
          duracionMs: contexto.ahora.getTime() - estado.desde.getTime(),
        },
      };
    }

    return { estado: ESTADO_VIGIA_INICIAL, decision: { tipo: "nada" } };
  }

  const desde = estado.desde ?? contexto.ahora;
  const fallos = estado.fallos + 1;

  if (estado.avisada) {
    return { estado: { fallos, desde, avisada: true }, decision: { tipo: "nada" } };
  }

  if (fallos >= FALLOS_PARA_AVISAR) {
    return {
      estado: { fallos, desde, avisada: true },
      decision: { tipo: "avisar-caida", desde, motivo: chequeo.motivo },
    };
  }

  return { estado: { fallos, desde, avisada: false }, decision: { tipo: "reintentar" } };
}

/** Lo que responde `/api/ready`, en lo que importa para explicar una caída. */
interface CuerpoReady {
  readonly status?: unknown;
  readonly checks?: {
    readonly database?: { readonly ok?: unknown };
    readonly configuration?: { readonly ok?: unknown; readonly problems?: unknown };
    readonly migrations?: { readonly pending?: unknown };
  };
}

/** Sin formato de Discord: el texto viene de la página y va a un mensaje. */
function sinFormato(texto: string): string {
  // El guion bajo se deja: los nombres de variables lo llevan (`SESSION_SECRET`).
  return texto.replace(/[`*~|<>@[\]]/g, "").slice(0, 120);
}

/**
 * Qué falla, en castellano, a partir de la respuesta de `/api/ready`.
 *
 * El detalle sólo viene si el bot manda el secreto de las tareas programadas
 * (`CRON_SECRET`); sin él, la página contesta sólo "degradada".
 */
export function describirProblemas(cuerpo: unknown): string | null {
  if (typeof cuerpo !== "object" || cuerpo === null) return null;
  const { status, checks } = cuerpo as CuerpoReady;

  if (!checks) {
    return status === "degraded"
      ? "la página anda, pero falla la base, la configuración o las migraciones"
      : null;
  }

  const partes: string[] = [];

  if (checks.database?.ok === false) partes.push("la base de datos no responde");

  if (checks.configuration?.ok === false) {
    const problemas = Array.isArray(checks.configuration.problems)
      ? checks.configuration.problems.filter((p): p is string => typeof p === "string")
      : [];
    partes.push(
      "la configuración tiene problemas" +
        (problemas.length > 0 ? " (" + problemas.slice(0, 3).map(sinFormato).join("; ") + ")" : ""),
    );
  }

  const pendientes = Number(checks.migrations?.pending ?? 0);
  if (pendientes > 0) {
    partes.push(
      pendientes + (pendientes === 1 ? " migración pendiente" : " migraciones pendientes"),
    );
  }

  return partes.length > 0 ? partes.join(", ") : null;
}

export async function consultarPagina(
  base: string,
  opciones: {
    /** `true` mira también la base (`/api/ready`); `false`, sólo la página. */
    readonly profundo: boolean;
    readonly secreto?: string | undefined;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  },
): Promise<Chequeo> {
  const pedir = opciones.fetch ?? fetch;
  /**
   * Veinticinco segundos: una función de Vercel fría más una base dormida
   * pueden sumar varios segundos, y eso no es una caída.
   */
  const timeoutMs = opciones.timeoutMs ?? 25_000;
  const ruta = opciones.profundo ? "/api/ready" : "/api/health";

  let respuesta: Response;
  try {
    respuesta = await pedir(base + ruta, {
      headers: opciones.secreto ? { Authorization: "Bearer " + opciones.secreto } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const nombre = (error as { name?: unknown } | null)?.name;
    if (nombre === "TimeoutError" || nombre === "AbortError") {
      return {
        ok: false,
        motivo: "No respondió en " + Math.round(timeoutMs / 1000) + " segundos.",
      };
    }

    const codigo = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    return {
      ok: false,
      motivo:
        "No se pudo conectar" +
        (typeof codigo === "string" ? " (" + codigo.replace(/[^A-Z0-9_]/g, "") + ")" : "") +
        ".",
    };
  }

  if (respuesta.ok) return { ok: true };

  const detalle = opciones.profundo
    ? describirProblemas(await respuesta.json().catch(() => null))
    : null;

  return {
    ok: false,
    motivo: "Respondió con error " + respuesta.status + (detalle ? ": " + detalle : "") + ".",
  };
}
