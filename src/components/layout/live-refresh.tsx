"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Refresco en vivo de la pantalla.
 *
 * Todas las páginas se renderizan en el servidor, así que lo que se ve es una
 * foto del momento en que se cargó. Si mati carga las horas del martes, pit no
 * se enteraba hasta recargar a mano. Esto vuelve a pedir los datos cada tanto y
 * React reemplaza sólo lo que cambió: no se pierde el scroll, ni lo que estabas
 * escribiendo, ni se ve un parpadeo.
 *
 * Tres detalles que hacen que no moleste:
 *
 *   · Con la pestaña en segundo plano no se pide nada. No tiene sentido gastar
 *     consultas contra una pantalla que nadie está mirando, y menos en el plan
 *     gratuito de Neon.
 *   · Al volver a la pestaña refresca de inmediato, que es el momento exacto en
 *     que a uno le importa estar viendo lo último.
 *   · Mientras hay un menú abierto o algo enfocado —un campo de la planilla a
 *     medio escribir— el refresco espera. Nada se reemplaza abajo de la mano.
 */

/** Cada cuánto se vuelve a pedir la pantalla, con la pestaña a la vista. */
const INTERVAL_MS = 12_000;

function isBusy(): boolean {
  /**
   * Con un arrastre a medias no se redibuja nada.
   *
   * Reemplazar las filas en medio del gesto dejaba la lista gris y la página
   * trabada: el arrastre quedaba sin dónde terminar. La marca la pone la
   * planilla al empezar a mover una fila.
   */
  if (document.body.dataset.arrastrando) return true;

  const active = document.activeElement;
  if (!active || active === document.body) return false;

  // Un campo a medio escribir o un menú abierto: no es momento de reemplazar.
  const tag = active.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (active instanceof HTMLElement && active.isContentEditable) return true;

  /**
   * Un diálogo abierto congela el refresco aunque no haya nada enfocado.
   *
   * `[role="dialog"]` no alcanza: el elemento `<dialog>` nativo tiene ese rol
   * de forma implícita, y un selector de atributo sólo ve los que están
   * escritos. Sin `dialog[open]` en la lista, el refresco de los doce segundos
   * cerraba el diálogo en la cara de quien lo estaba leyendo, y se llevaba
   * puesto el motivo a medio escribir.
   */
  return document.querySelector('[role="menu"], [role="dialog"], dialog[open]') !== null;
}

export function LiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const pending = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      if (isBusy()) {
        // Se reintenta en el próximo tic, cuando la mano esté libre.
        pending.current = true;
        return;
      }
      pending.current = false;
      router.refresh();
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(refresh, INTERVAL_MS);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refresh);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refresh);
    };
    // `pathname` reinicia el ciclo al navegar: la pantalla nueva arranca limpia.
  }, [router, pathname]);

  // No dibuja nada: vive para el efecto.
  return null;
}
