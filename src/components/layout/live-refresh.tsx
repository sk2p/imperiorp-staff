"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { INTERVALO_MS, hayQueRedibujar, tocaMirar } from "@/lib/core/refresco";

/**
 * Refresco en vivo de la pantalla.
 *
 * Todas las páginas se renderizan en el servidor, así que lo que se ve es una
 * foto del momento en que se cargó. Si mati carga las horas del martes, pit no
 * se enteraba hasta recargar a mano. Esto vuelve a pedir los datos cuando hay
 * algo nuevo y React reemplaza sólo lo que cambió: no se pierde el scroll, ni
 * lo que estabas escribiendo, ni se ve un parpadeo.
 *
 * Primero pregunta, después redibuja. Antes redibujaba la pantalla entera cada
 * doce segundos, hubiera cambios o no: más de una docena de consultas por
 * pestaña, todo el día, para mostrar lo mismo. Ahora cada doce segundos pide
 * la firma de los datos —una consulta chica— y sólo si cambió pide la pantalla.
 * Los detalles están en `lib/core/refresco.ts`.
 *
 * Lo que hace que no moleste:
 *
 *   · Con la pestaña en segundo plano no se pide nada.
 *   · Al volver a la pestaña se pregunta de inmediato, que es el momento exacto
 *     en que a uno le importa estar viendo lo último.
 *   · Una pantalla que quedó sola —cinco minutos sin mouse ni teclado— pregunta
 *     una vez por minuto en lugar de cinco.
 *   · Mientras hay un menú abierto o algo enfocado —un campo de la planilla a
 *     medio escribir— se espera. Nada se reemplaza abajo de la mano.
 */

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

/** Lo que cuenta como "hay alguien usando la pantalla". */
const ACTIVIDAD = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

export function LiveRefresh({ firma }: { readonly firma: string | null }) {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * La firma de lo que se está viendo. Llega con cada render del servidor, así
   * que después de redibujar ya es la nueva sin que haya que anotarla a mano.
   */
  const firmaPantalla = useRef(firma);

  useEffect(() => {
    firmaPantalla.current = firma;
  }, [firma]);

  useEffect(() => {
    const montado = Date.now();
    let ultimaMirada = montado;
    let ultimoRedibujo = montado;
    let ultimaActividad = montado;
    let mirando = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const actividad = () => {
      ultimaActividad = Date.now();
    };

    const redibujar = () => {
      ultimoRedibujo = Date.now();
      router.refresh();
    };

    const mirar = async (yaMismo: boolean) => {
      if (document.visibilityState !== "visible" || mirando) return;

      const momento = Date.now();

      // Al volver a la pestaña se mira ya, pero no dos veces seguidas: el foco
      // y el cambio de visibilidad suelen llegar juntos.
      if (yaMismo) {
        if (momento - ultimaMirada < 2_000) return;
      } else if (!tocaMirar({ ahora: momento, ultimaMirada, ultimaActividad })) {
        return;
      }

      // Con la mano ocupada no se mira: el próximo tic lo vuelve a intentar.
      if (isBusy()) return;

      mirando = true;
      ultimaMirada = momento;
      let firmaServidor: string | null = null;

      try {
        const respuesta = await fetch("/api/firma", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });

        // La sesión venció: redibujar lleva a la pantalla de ingreso, que es
        // justo lo que corresponde.
        if (respuesta.status === 401 || respuesta.redirected) {
          redibujar();
          return;
        }

        if (respuesta.ok) {
          const datos: unknown = await respuesta.json();
          if (
            datos !== null &&
            typeof datos === "object" &&
            "firma" in datos &&
            typeof datos.firma === "string"
          ) {
            firmaServidor = datos.firma;
          }
        }
      } catch {
        // Sin red: se reintenta en el próximo tic.
      } finally {
        mirando = false;
      }

      if (isBusy()) return;

      if (
        hayQueRedibujar({
          firmaPantalla: firmaPantalla.current,
          firmaServidor,
          ahora: Date.now(),
          ultimoRedibujo,
        })
      ) {
        redibujar();
      }
    };

    // El tic es corto y barato —mira el reloj y nada más—; lo que decide si
    // de verdad se pregunta es `tocaMirar`.
    const iniciar = () => {
      if (timer) return;
      timer = setInterval(() => void mirar(false), INTERVALO_MS / 3);
    };

    const detener = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const alCambiarVisibilidad = () => {
      if (document.visibilityState === "visible") {
        void mirar(true);
        iniciar();
      } else {
        detener();
      }
    };

    const alEnfocar = () => void mirar(true);

    if (document.visibilityState === "visible") iniciar();

    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    window.addEventListener("focus", alEnfocar);
    for (const evento of ACTIVIDAD) {
      window.addEventListener(evento, actividad, { passive: true });
    }

    return () => {
      detener();
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
      window.removeEventListener("focus", alEnfocar);
      for (const evento of ACTIVIDAD) window.removeEventListener(evento, actividad);
    };
    // `pathname` reinicia el ciclo al navegar: la pantalla nueva arranca limpia.
  }, [router, pathname]);

  // No dibuja nada: vive para el efecto.
  return null;
}
