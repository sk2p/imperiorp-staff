import Link from "next/link";

import { Icon } from "@/components/layout/icons";
import { cn } from "@/components/ui/primitives";
import { formatCalendarDateShort, formatPeriodLabel } from "@/domain/periods";

/**
 * Qué período estás tocando.
 *
 * En Horas y en Pagos se puede cambiar de período con un desplegable chico
 * arriba a la derecha, y eso alcanzaba para elegir pero no para acordarse. Es
 * fácil quedar mirando la semana pasada, cargar horas ahí y no entender por qué
 * no aparecen; peor todavía es pagar contra el período equivocado.
 *
 * Esta banda lo dice de una, con el color como primer aviso: rojo cuando el
 * período está abierto —el que se está cargando ahora— y gris cuando ya está
 * cerrado, con la advertencia de que lo que se ve quedó congelado.
 */
export function PeriodBanner({
  startDate,
  endDate,
  status,
  isCurrent,
  accion,
  currentHref,
}: {
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  /** Si es el período abierto más reciente: el que se está trabajando. */
  readonly isCurrent: boolean;
  /** Qué se está haciendo acá: "Cargando horas de", "Pagando". */
  readonly accion: string;
  /** Link para volver al período en curso, si se está mirando otro. */
  readonly currentHref?: string | undefined;
}) {
  const cerrado = status === "closed";

  return (
    <div
      className={cn("period-banner", cerrado ? "period-banner-cerrado" : "period-banner-abierto")}
    >
      <span className="period-banner-dot" aria-hidden />

      <div className="min-w-0 flex-1">
        <p className="text-chalk-500 text-[0.625rem] font-semibold tracking-[0.14em] uppercase">
          {accion}
        </p>
        <p className="text-chalk-50 mt-0.5 text-sm font-bold">
          {formatCalendarDateShort(startDate)} → {formatCalendarDateShort(endDate)}
          <span className="text-chalk-600 ml-2 text-xs font-normal">
            {formatPeriodLabel(startDate, endDate)}
          </span>
        </p>
      </div>

      <span className={cn("period-chip", cerrado ? "period-chip-cerrado" : "period-chip-abierto")}>
        <Icon name={cerrado ? "lock" : "clock"} size={13} />
        {cerrado ? "Cerrado" : "Abierto"}
      </span>

      {/* Estás mirando algo que no es el período en curso: se avisa y se ofrece
          el camino de vuelta en el mismo lugar donde aparece el problema. */}
      {!isCurrent && currentHref ? (
        <Link href={currentHref} className="period-volver">
          <Icon name="history" size={13} />
          Ir al período en curso
        </Link>
      ) : null}
    </div>
  );
}
