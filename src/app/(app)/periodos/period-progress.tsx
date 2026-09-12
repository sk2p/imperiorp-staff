import { cn } from "@/components/ui/primitives";
import { localDate } from "@/domain/clock";
import { eachDayOfPeriod, weekdayName } from "@/domain/periods";

/**
 * En qué punto del período estamos.
 *
 * La pantalla decía cuántas horas van y cuánto se generó, pero no lo que más se
 * pregunta al mirarla: cuánto falta para que cierre. Con la rotación automática
 * de los sábados, saber que quedan dos días es lo que decide si hay tiempo de
 * reclamarle las horas a alguien o ya es tarde.
 *
 * Cada día es un bloque: los pasados llenos, el de hoy marcado, los que vienen
 * vacíos. Se lee de un vistazo, sin contar en un calendario.
 */
export function PeriodProgress({
  startDate,
  endDate,
}: {
  readonly startDate: string;
  readonly endDate: string;
}) {
  const dias = eachDayOfPeriod(startDate, endDate);
  const hoy = localDate();

  const transcurridos = dias.filter((dia) => dia < hoy).length;
  const enCurso = dias.includes(hoy);
  const restantes = dias.filter((dia) => dia > hoy).length;

  /**
   * Un período puede estar fuera de sus propias fechas: si todavía no empezó, o
   * si venció y nadie lo cerró. Decirlo es más útil que mostrar una barra llena
   * o vacía sin explicación.
   */
  const estado = enCurso
    ? restantes === 0
      ? "Último día"
      : restantes === 1
        ? "Queda 1 día"
        : "Quedan " + restantes + " días"
    : hoy < (dias[0] ?? "")
      ? "Todavía no empezó"
      : "Ya terminó: falta cerrarlo";

  return (
    <div className="border-t border-white/[0.07] px-4 py-3.5">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="mb-0 overline">Avance del período</p>
        <p
          className={cn(
            "text-[0.6875rem] font-semibold",
            enCurso ? "text-chalk-300" : "text-amber-400",
          )}
        >
          {estado}
          {enCurso ? (
            <span className="text-chalk-600 ml-1.5 font-normal">
              · día {transcurridos + 1} de {dias.length}
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex gap-1" aria-hidden>
        {dias.map((dia) => {
          const pasado = dia < hoy;
          const esHoy = dia === hoy;

          return (
            <span
              key={dia}
              title={weekdayName(dia) + " " + dia}
              className={cn("dia-bloque", pasado && "dia-pasado", esHoy && "dia-hoy")}
            />
          );
        })}
      </div>

      <div className="text-chalk-700 mt-1.5 flex justify-between text-[0.625rem]">
        {dias.map((dia) => (
          <span key={dia} className="flex-1 text-center">
            {weekdayName(dia).slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>
    </div>
  );
}
