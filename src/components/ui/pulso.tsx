import { cn } from "@/components/ui/primitives";
import { formatMinutes } from "@/domain/time";

/**
 * El pulso de la semana: una barrita por día.
 *
 * Un total —"17h 6m"— no distingue a quien hizo dos horas y media todos los
 * días de quien metió diecisiete un domingo y no apareció más. Son dos
 * personas distintas para cualquiera que maneje staff, y hasta ahora había que
 * abrir la planilla y leer siete casillas para notar la diferencia.
 *
 * Siete barras lo dicen sin leer. La altura es relativa al día más alto de esa
 * misma persona y no al del staff entero: lo que interesa acá es la forma de su
 * semana —pareja o de un saque—, no si labura más o menos que otro. Para eso
 * está el número al lado.
 *
 * Todo HTML y CSS, sin una línea de JavaScript en el navegador. En el teléfono
 * se ve igual: son elementos de ancho flexible adentro de una caja.
 *
 * Va todo en `span` y no en `div` a propósito. Esto se dibuja adentro de un
 * párrafo, y un `div` adentro de un `<p>` es HTML inválido: el navegador cierra
 * el párrafo por su cuenta, el árbol que arma no coincide con el que mandó el
 * servidor, y React tira toda la página al piso. Se pierde el JavaScript de la
 * pantalla entera —diálogos, arrastre, todo— por una etiqueta mal elegida.
 */
export function PulsoSemanal({
  dias,
  className,
}: {
  /** Minutos de cada día del período, en orden. */
  readonly dias: readonly { readonly workDate: string; readonly minutes: number }[];
  readonly className?: string;
}) {
  const mayor = dias.reduce((tope, dia) => Math.max(tope, dia.minutes), 0);

  if (mayor <= 0) {
    return (
      <span className={cn("pulso pulso-vacio", className)} aria-hidden>
        {dias.map((dia) => (
          <span key={dia.workDate} className="pulso-barra" style={{ height: "2px" }} />
        ))}
      </span>
    );
  }

  return (
    <span
      className={cn("pulso", className)}
      role="img"
      aria-label={
        "Reparto de la semana: " +
        dias
          .filter((dia) => dia.minutes > 0)
          .map((dia) => diaCorto(dia.workDate) + " " + formatMinutes(dia.minutes))
          .join(", ")
      }
    >
      {dias.map((dia) => {
        // Mínimo visible para un día con horas: una barra de un pelo igual
        // tiene que distinguirse de un día en cero.
        const alto = dia.minutes > 0 ? Math.max(14, Math.round((dia.minutes / mayor) * 100)) : 0;

        return (
          <span
            key={dia.workDate}
            className={cn("pulso-barra", dia.minutes > 0 && "pulso-con-horas")}
            style={{ height: alto > 0 ? alto + "%" : "2px" }}
            title={diaCorto(dia.workDate) + " · " + formatMinutes(dia.minutes)}
          />
        );
      })}
    </span>
  );
}

/** "2026-09-12" → "12/09". Suficiente para un globito. */
function diaCorto(iso: string): string {
  const [, mes, dia] = iso.split("-");
  return dia + "/" + mes;
}
