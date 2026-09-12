import { sql } from "drizzle-orm";

import { closeDatabase, db, withTransaction } from "@/db";
import { localDate } from "@/domain/clock";
import { formatMoney } from "@/domain/money";
import { calculateEarnings } from "@/domain/payroll";
import { categoryForRank, rankLabel, type StaffRank } from "@/domain/ranks";
import { formatMinutes } from "@/domain/time";
import { logger } from "@/lib/core/logger";

/**
 * Devuelve a cada período anterior los rangos que su gente tenía ENTONCES.
 *
 * El problema que repara:
 *
 * Cada fila de la planilla guarda el nombre, el rango y la tarifa de la persona
 * al momento de liquidar. Esa foto existe justamente para que un ascenso
 * posterior no reescriba lo que alguien cobró. Pero el recálculo volvía a
 * copiarlos del staff de HOY cada vez que se tocaba el período, así que la foto
 * se iba actualizando sola: alguien que era MOD++ en septiembre y hoy es ADM+
 * figuraba como ADM+ en septiembre, y sus horas de septiembre pasaban a valer
 * la tarifa de ADM+. Alcanzaba con corregir una hora del mes pasado.
 *
 * El recálculo ya no lo hace. Pero las fotos que se reescribieron antes de ese
 * arreglo quedaron con los rangos de hoy, y esto las vuelve a su lugar.
 *
 * De dónde sale el rango verdadero: del historial de rangos, que sí guarda cada
 * cambio con su fecha. El rango de alguien al cierre de un período es el que
 * dejó el último cambio anterior a esa fecha. Si no hubo ninguno, es el `desde`
 * del primer cambio posterior — o sea, el que tenía antes de ese cambio.
 *
 * Uso:
 *   pnpm db:reparar-snapshots            ← sólo informa, no toca nada
 *   pnpm db:reparar-snapshots --aplicar  ← escribe los cambios
 *
 * Nunca toca períodos cerrados (sus filas están congeladas) ni el período en
 * curso, donde el rango de hoy es el correcto.
 */

interface Desajuste {
  readonly weekId: string;
  readonly periodo: string;
  readonly staffMemberId: string;
  readonly nombre: string;
  readonly rangoActual: string;
  readonly rangoDeEntonces: string;
  readonly tarifaDeEntonces: number;
  readonly minutos: number;
  readonly importeActual: number;
  readonly importeCorrecto: number;
}

async function detectar(): Promise<Desajuste[]> {
  const hoy = localDate();

  const resultado = await db.execute<{
    week_id: string;
    start_date: string;
    end_date: string;
    staff_member_id: string;
    staff_name_snapshot: string;
    rank_snapshot: string;
    total_minutes: number;
    calculated_amount: string;
    rango_de_entonces: string | null;
  }>(sql`
    select r.week_id, w.start_date, w.end_date, r.staff_member_id,
           r.staff_name_snapshot, r.rank_snapshot,
           r.total_minutes, r.calculated_amount,
           coalesce(
             (select h.to_rank from staff_rank_history h
               where h.staff_member_id = r.staff_member_id
                 and h.created_at < (w.end_date + 1)::timestamptz
               order by h.created_at desc limit 1),
             (select coalesce(h.from_rank, h.to_rank) from staff_rank_history h
               where h.staff_member_id = r.staff_member_id
                 and h.created_at >= (w.end_date + 1)::timestamptz
               order by h.created_at asc limit 1)
           ) as rango_de_entonces
      from weekly_staff_records r
      join weeks w on w.id = r.week_id
     where r.frozen_at is null
       and w.status = 'open'
       and not (w.start_date <= ${hoy}::date and w.end_date >= ${hoy}::date)
  `);

  const tarifas = await db.execute<{ rank: string; rate_per_hour: number }>(
    sql`select rank, rate_per_hour from rank_rates`,
  );
  const porRango = new Map(
    (tarifas.rows ?? []).map((fila) => [fila.rank, Number(fila.rate_per_hour)]),
  );

  const desajustes: Desajuste[] = [];

  for (const fila of resultado.rows ?? []) {
    const entonces = fila.rango_de_entonces;
    if (!entonces || entonces === fila.rank_snapshot) continue;

    const tarifaDeEntonces = porRango.get(entonces);
    if (tarifaDeEntonces === undefined) {
      logger.warn("Rango sin tarifa: se omite la fila", {
        rango: entonces,
        ficha: fila.staff_name_snapshot,
      });
      continue;
    }

    desajustes.push({
      weekId: fila.week_id,
      periodo: fila.start_date + " → " + fila.end_date,
      staffMemberId: fila.staff_member_id,
      nombre: fila.staff_name_snapshot,
      rangoActual: fila.rank_snapshot,
      rangoDeEntonces: entonces,
      tarifaDeEntonces,
      minutos: fila.total_minutes,
      importeActual: Number(fila.calculated_amount),
      importeCorrecto: calculateEarnings(fila.total_minutes, tarifaDeEntonces),
    });
  }

  return desajustes;
}

async function main(): Promise<void> {
  const aplicar = process.argv.includes("--aplicar");
  const desajustes = await detectar();

  if (desajustes.length === 0) {
    console.log(
      "\nNo hay nada que reparar: los períodos anteriores tienen los rangos de su momento.\n",
    );
    return;
  }

  const deltaTotal = desajustes.reduce(
    (suma, dato) => suma + (dato.importeCorrecto - dato.importeActual),
    0,
  );

  console.log("\n" + "=".repeat(78));
  console.log("  RANGOS QUE NO SON LOS DE ESE PERÍODO - " + desajustes.length + " fila(s)");
  console.log("=".repeat(78));

  for (const dato of desajustes) {
    const delta = dato.importeCorrecto - dato.importeActual;

    console.log(
      "  " +
        dato.periodo +
        "  " +
        dato.nombre.padEnd(14).slice(0, 14) +
        rankLabel(dato.rangoActual).padEnd(15) +
        " -> " +
        rankLabel(dato.rangoDeEntonces).padEnd(15) +
        formatMinutes(dato.minutos).padStart(9) +
        "  " +
        formatMoney(dato.importeActual).padStart(13) +
        " -> " +
        formatMoney(dato.importeCorrecto).padStart(13) +
        "  (" +
        (delta >= 0 ? "+" : "") +
        formatMoney(delta) +
        ")",
    );
  }

  console.log("-".repeat(78));
  console.log("  Diferencia total: " + (deltaTotal >= 0 ? "+" : "") + formatMoney(deltaTotal));
  console.log("=".repeat(78) + "\n");

  if (!aplicar) {
    console.log("  No se escribió nada. Para aplicarlo:  pnpm db:reparar-snapshots --aplicar\n");
    return;
  }

  await withTransaction(async (tx) => {
    for (const dato of desajustes) {
      await tx.execute(sql`
        update weekly_staff_records
           set rank_snapshot        = ${dato.rangoDeEntonces},
               category_snapshot    = ${categoryForRank(dato.rangoDeEntonces as StaffRank)},
               hourly_rate_snapshot = ${dato.tarifaDeEntonces},
               calculated_amount    = ${dato.importeCorrecto},
               version              = version + 1,
               updated_at           = now()
         where week_id = ${dato.weekId}::uuid
           and staff_member_id = ${dato.staffMemberId}::uuid
           and frozen_at is null
      `);
    }
  });

  console.log("  Aplicado: " + desajustes.length + " fila(s) devueltas a su rango de entonces.\n");
}

main()
  .catch((error) => {
    logger.error("Falló la reparación de snapshots", { error });
    process.exitCode = 1;
  })
  .finally(closeDatabase);
