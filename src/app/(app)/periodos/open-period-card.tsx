import { Badge, Callout, Card, CardHeader } from "@/components/ui/primitives";
import { formatMoney } from "@/domain/money";
import { formatPeriodLabel, periodLengthInDays } from "@/domain/periods";
import { formatMinutes } from "@/domain/time";
import type { ClosePreflight, WeekBreakdown, WeekListItem } from "@/server/weeks";
import { PeriodInside } from "./period-breakdown";
import { ClosePeriodDialog, EditPeriodDialog } from "./period-dialogs";
import { PeriodProgress } from "./period-progress";

/**
 * La tarjeta de un período abierto.
 *
 * Antes existía una sola, la del "período activo", y con dos períodos abiertos
 * —lo normal el día que se abre el nuevo antes de cerrar el viejo— el segundo
 * quedaba reducido a una fila de tabla. Todas las horas del mes anterior,
 * invisibles.
 *
 * Ahora cada período abierto tiene la suya, con su avance, su desglose y su
 * botón de cerrar. El primero se marca como activo porque es al que van las
 * horas de hoy; los demás siguen siendo tan reales como él.
 */
export function OpenPeriodCard({
  week,
  preflight,
  breakdown,
  activo,
  puedeCerrar,
  puedeEditar,
}: {
  readonly week: WeekListItem;
  readonly preflight: ClosePreflight | null;
  readonly breakdown: WeekBreakdown | undefined;
  readonly activo: boolean;
  readonly puedeCerrar: boolean;
  readonly puedeEditar?: boolean;
}) {
  return (
    <Card className={"revela " + (activo ? "border-imperial-500/25" : "border-white/[0.08]")}>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{formatPeriodLabel(week.startDate, week.endDate)}</span>
            {activo ? (
              <Badge tone="jade" dot>
                Activo
              </Badge>
            ) : (
              <Badge tone="amber" dot>
                Abierto sin cerrar
              </Badge>
            )}
            {week.label ? (
              <span className="text-chalk-600 text-xs font-normal">{week.label}</span>
            ) : null}
          </span>
        }
        description={
          activo
            ? periodLengthInDays(week.startDate, week.endDate) +
              " días · " +
              week.memberCount +
              " miembros · las horas de hoy entran acá"
            : periodLengthInDays(week.startDate, week.endDate) +
              " días · " +
              week.memberCount +
              " miembros · sigue abierto, todavía no se puede pagar"
        }
        action={
          <div className="flex items-center gap-1.5">
            {puedeEditar ? (
              <EditPeriodDialog
                weekId={week.id}
                version={week.version}
                startDate={week.startDate}
                endDate={week.endDate}
                label={week.label}
                notes={week.notes}
                periodLabel={formatPeriodLabel(week.startDate, week.endDate)}
              />
            ) : null}
            {preflight && puedeCerrar ? (
              <ClosePeriodDialog
                summary={{
                  weekId: week.id,
                  version: week.version,
                  startDate: week.startDate,
                  endDate: week.endDate,
                  totalMinutes: preflight.totalMinutes,
                  totalAmount: preflight.totalAmount,
                  memberCount: preflight.memberCount,
                  membersWithHours: preflight.membersWithHours,
                  warnings: preflight.warnings,
                }}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <div>
          <p className="overline">Horas acumuladas</p>
          <p className="tnum text-chalk-50 mt-1 text-lg font-bold">
            {formatMinutes(week.totalMinutes)}
          </p>
        </div>
        <div>
          <p className="overline">Importe generado</p>
          <p className="tnum text-imperial-400 mt-1 text-lg font-bold">
            {formatMoney(week.totalAmount)}
          </p>
        </div>
        <div>
          <p className="overline">Miembros con horas</p>
          <p className="tnum text-chalk-50 mt-1 text-lg font-bold">
            {breakdown ? breakdown.membersWithHours : 0} / {week.memberCount}
          </p>
        </div>
        <div>
          <p className="overline">Advertencias</p>
          <p
            className={
              "tnum mt-1 text-lg font-bold " +
              (preflight && preflight.warnings.length > 0 ? "text-amber-400" : "text-jade-400")
            }
          >
            {preflight ? preflight.warnings.length : "—"}
          </p>
        </div>
      </div>

      {/* Las notas del período, si alguien escribió alguna. Se muestran acá y
          no escondidas atrás de un ícono: se escriben justamente para que las
          lea quien abra esta pantalla. */}
      {week.notes ? (
        <div className="border-t border-white/[0.07] px-4 py-3">
          <p className="mb-0 overline">Notas</p>
          <p className="text-chalk-400 mt-1 text-xs leading-relaxed whitespace-pre-line">
            {week.notes}
          </p>
        </div>
      ) : null}

      <PeriodProgress startDate={week.startDate} endDate={week.endDate} />

      <PeriodInside breakdown={breakdown} memberCount={week.memberCount} />

      {preflight && preflight.warnings.length > 0 ? (
        <div className="border-t border-white/[0.07] px-4 py-3">
          <Callout tone="warning" title="Revisá antes de cerrar">
            <ul className="mt-1 flex flex-col gap-1">
              {preflight.warnings.slice(0, 4).map((warning, index) => (
                <li key={index}>· {warning.message}</li>
              ))}
              {preflight.warnings.length > 4 ? (
                <li className="text-chalk-500">
                  y {preflight.warnings.length - 4} advertencia(s) más.
                </li>
              ) : null}
            </ul>
          </Callout>
        </div>
      ) : null}
    </Card>
  );
}
