"use client";

import { useEffect, useRef } from "react";

/**
 * Un halo que sigue al puntero por la pantalla de ingreso.
 *
 * Es lo primero que ve cualquiera al entrar, y era un rectángulo negro con un
 * formulario en el medio. Esto le da algo vivo sin agregar nada que leer.
 *
 * Detalles que lo hacen barato:
 *
 *   · Escribe dos variables CSS sobre un nodo. React no se entera y no
 *     re-dibuja nada en cada movimiento del mouse.
 *   · Se ajusta al cuadro de refresco del navegador, así que aunque lleguen
 *     doscientos eventos por segundo, se pinta una vez por cuadro.
 *   · Sin mouse no se monta: en el teléfono no hay a quién seguir.
 */
export function Spotlight() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const nodo = ref.current;
    if (!nodo) return;

    // Sin puntero fino —un teléfono— no hay nada que seguir.
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let pedido = 0;
    let x = 0;
    let y = 0;

    const pintar = () => {
      pedido = 0;
      nodo.style.setProperty("--foco-x", x + "px");
      nodo.style.setProperty("--foco-y", y + "px");
      nodo.style.setProperty("--foco-opacidad", "1");
    };

    const mover = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      // Un solo repintado por cuadro, por más eventos que lleguen.
      if (pedido === 0) pedido = requestAnimationFrame(pintar);
    };

    const salir = () => {
      nodo.style.setProperty("--foco-opacidad", "0");
    };

    window.addEventListener("pointermove", mover, { passive: true });
    document.addEventListener("pointerleave", salir);

    return () => {
      if (pedido !== 0) cancelAnimationFrame(pedido);
      window.removeEventListener("pointermove", mover);
      document.removeEventListener("pointerleave", salir);
    };
  }, []);

  return <div ref={ref} aria-hidden className="foco" />;
}
