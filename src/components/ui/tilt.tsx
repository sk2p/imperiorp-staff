"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Perspectiva 3D al pasar por encima.
 *
 * La ficha se inclina siguiendo al puntero, muy poco: seis grados de tope. El
 * efecto llamativo de las galerías de componentes usa veinte y queda lindo en
 * una pantalla de presentación; en una lista de cuarenta fichas que alguien
 * recorre todos los días, marea.
 *
 * Está escrito a mano y no con una librería de animación a propósito. Traer
 * framer-motion para esto serían cincuenta kilobytes de JavaScript en el
 * teléfono del staff para inclinar un recuadro.
 *
 * POR QUÉ IBA CON RETRASO, y cómo se arregló:
 *
 *   · La ficha tenía una transición de 220 ms con rebote en `transform`. Cada
 *     movimiento del mouse cambiaba el destino, la transición volvía a arrancar
 *     desde la mitad del camino, y la ficha iba siempre un cuarto de segundo
 *     detrás del cursor, bamboleándose. Ahora, mientras el puntero está
 *     encima, la marca `data-inclinando` le pone una transición cortísima y sin
 *     rebote: sigue a la mano. El rebote queda sólo para la vuelta, al salir.
 *   · Se medía la caja en cada evento del mouse, y llegan más de cien por
 *     segundo. Cada medición obliga al navegador a recalcular estilos. Ahora se
 *     anota dónde está el puntero y se pinta una sola vez por cuadro.
 *
 * En el teléfono no hace nada —sólo con puntero fino, un mouse— y respeta a
 * quien pidió menos movimiento en su sistema.
 */

/** Grados máximos de inclinación. Pasado esto, deja de ser sutil. */
const MAX_GRADOS = 6;

export function Tilt({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const nodo = ref.current;
    if (!nodo) return;

    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let pedido = 0;
    let x = 0;
    let y = 0;

    const pintar = () => {
      pedido = 0;

      const caja = nodo.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (x - caja.left) / caja.width));
      const py = Math.min(1, Math.max(0, (y - caja.top) / caja.height));

      // De 0..1 a -1..1, y de ahí a grados. El eje X se invierte para que la
      // ficha se incline HACIA el puntero y no al revés.
      nodo.style.setProperty("--tilt-x", ((0.5 - py) * 2 * MAX_GRADOS).toFixed(2) + "deg");
      nodo.style.setProperty("--tilt-y", ((px - 0.5) * 2 * MAX_GRADOS).toFixed(2) + "deg");
      // Dónde está el puntero, para el brillo que lo sigue.
      nodo.style.setProperty("--tilt-luz-x", (px * 100).toFixed(1) + "%");
      nodo.style.setProperty("--tilt-luz-y", (py * 100).toFixed(1) + "%");
    };

    const entrar = (evento: PointerEvent) => {
      if (evento.pointerType !== "mouse") return;
      nodo.dataset.inclinando = "";
    };

    const mover = (evento: PointerEvent) => {
      // `pointerType` distingue el mouse del dedo: en táctil no hay "hover".
      if (evento.pointerType !== "mouse") return;
      x = evento.clientX;
      y = evento.clientY;
      if (pedido === 0) pedido = requestAnimationFrame(pintar);
    };

    const salir = () => {
      if (pedido !== 0) {
        cancelAnimationFrame(pedido);
        pedido = 0;
      }

      // Primero vuelve la transición con rebote, después el cero: así la
      // vuelta a su lugar sí es suave.
      delete nodo.dataset.inclinando;
      nodo.style.setProperty("--tilt-x", "0deg");
      nodo.style.setProperty("--tilt-y", "0deg");
    };

    nodo.addEventListener("pointerenter", entrar);
    nodo.addEventListener("pointermove", mover, { passive: true });
    nodo.addEventListener("pointerleave", salir);

    return () => {
      if (pedido !== 0) cancelAnimationFrame(pedido);
      nodo.removeEventListener("pointerenter", entrar);
      nodo.removeEventListener("pointermove", mover);
      nodo.removeEventListener("pointerleave", salir);
    };
  }, []);

  return (
    <div ref={ref} className={className} style={{ perspective: "900px" }}>
      {children}
    </div>
  );
}
