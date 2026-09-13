import { Skeleton } from "@/components/ui/primitives";

/**
 * Lo que se ve mientras llega una pantalla.
 *
 * Sin esto, tocar un enlace no hacía nada visible hasta que el servidor
 * terminaba de consultar: el menú marcaba la sección nueva y abajo seguía la
 * vieja, quieta, uno o dos segundos. En el teléfono, con la base recién
 * despierta, parecía que el toque no había entrado y la gente volvía a tocar.
 *
 * La forma imita la de las pantallas —encabezado, cuatro cifras, un panel
 * ancho y uno angosto— para que al llegar el contenido no salte todo de lugar.
 * No lleva JavaScript: es HTML que Next muestra al instante.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <span className="sr-only" role="status">
        Cargando…
      </span>

      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-2.5 w-36" />
        <Skeleton className="h-7 w-80 max-w-full" />
        <Skeleton className="h-3 w-[28rem] max-w-full" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((indice) => (
          <div key={indice} className="surface flex flex-col gap-3 p-4">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-2.5 w-36 max-w-full" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="surface flex flex-col gap-4 p-4 lg:col-span-2">
          <Skeleton className="h-3.5 w-48" />
          {[0, 1, 2, 3, 4, 5].map((indice) => (
            <div key={indice} className="flex items-center gap-3">
              <Skeleton className="h-3 w-5" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-40 max-w-full" />
                <Skeleton className="h-1 w-full" />
              </div>
              <Skeleton className="h-3 w-14" />
            </div>
          ))}
        </div>

        <div className="surface flex flex-col gap-4 p-4">
          <Skeleton className="h-3.5 w-40" />
          <div className="flex items-center gap-4">
            <Skeleton className="h-28 w-28 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
