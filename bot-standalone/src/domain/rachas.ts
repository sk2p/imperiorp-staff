import { previousLocalDate } from "./clock";
import type { CalendarDate } from "./periods";

/**
 * IMPERIO RP — Rachas de días fichando.
 *
 * Una racha son días SEGUIDOS con horas. La base ya los devuelve agrupados en
 * tramos —cada tramo, días consecutivos sin un hueco—; esto decide cuál de esos
 * tramos sigue vivo y cuál fue el más largo.
 *
 * Un tramo sigue vivo si su último día es hoy o AYER. Si sólo contara hoy, a
 * las diez de la mañana todo el staff tendría racha cero por no haber fichado
 * todavía, y la tabla premiaría a quien ficha de madrugada.
 */

export interface Tramo {
  readonly staffMemberId: string;
  readonly dias: number;
  /** Último día del tramo. */
  readonly hasta: CalendarDate;
}

export interface Racha {
  /** Días seguidos de la racha viva; cero si no tiene. */
  readonly actual: number;
  /** El tramo más largo que tuvo alguna vez. */
  readonly mejor: number;
}

export function resumirRachas(tramos: readonly Tramo[], hoy: CalendarDate): Map<string, Racha> {
  const ayer = previousLocalDate(hoy);
  const resultado = new Map<string, Racha>();

  for (const tramo of tramos) {
    const previa = resultado.get(tramo.staffMemberId) ?? { actual: 0, mejor: 0 };
    const vivo = tramo.hasta === hoy || tramo.hasta === ayer;

    resultado.set(tramo.staffMemberId, {
      actual: vivo ? Math.max(previa.actual, tramo.dias) : previa.actual,
      mejor: Math.max(previa.mejor, tramo.dias),
    });
  }

  return resultado;
}
