"use client";

import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

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
 * teléfono del staff para inclinar un recuadro. Acá alcanzan dos variables CSS
 * escritas directo sobre el nodo, sin re-dibujar React en cada movimiento del
 * mouse.
 *
 * En el teléfono no hace nada: se activa sólo con puntero fino —un mouse—, y
 * respeta a quien pidió menos movimiento en su sistema.
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

  const mover = (event: ReactPointerEvent<HTMLDivElement>) => {
    const nodo = ref.current;
    // `pointerType` distingue el mouse del dedo: en táctil no hay "hover".
    if (!nodo || event.pointerType !== "mouse") return;

    const caja = nodo.getBoundingClientRect();
    const x = (event.clientX - caja.left) / caja.width;
    const y = (event.clientY - caja.top) / caja.height;

    // De 0..1 a -1..1, y de ahí a grados. El eje X se invierte para que la
    // ficha se incline HACIA el puntero y no al revés.
    nodo.style.setProperty("--tilt-x", ((0.5 - y) * 2 * MAX_GRADOS).toFixed(2) + "deg");
    nodo.style.setProperty("--tilt-y", ((x - 0.5) * 2 * MAX_GRADOS).toFixed(2) + "deg");
    // Dónde está el puntero, para el brillo que lo sigue.
    nodo.style.setProperty("--tilt-luz-x", (x * 100).toFixed(1) + "%");
    nodo.style.setProperty("--tilt-luz-y", (y * 100).toFixed(1) + "%");
  };

  const salir = () => {
    const nodo = ref.current;
    if (!nodo) return;

    // Vuelve a cero; la transición del CSS hace el resto.
    nodo.style.setProperty("--tilt-x", "0deg");
    nodo.style.setProperty("--tilt-y", "0deg");
  };

  return (
    <div
      ref={ref}
      onPointerMove={mover}
      onPointerLeave={salir}
      className={className}
      style={{ perspective: "900px" }}
    >
      {children}
    </div>
  );
}
