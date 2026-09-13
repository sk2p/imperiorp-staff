import { asc, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { staffMembers } from "@/db/schema";
import { PERMISSIONS } from "@/domain/permissions";
import { getAuthContext } from "@/lib/auth/context";

export const dynamic = "force-dynamic";

const SIN_CACHE = { "Cache-Control": "no-store" } as const;

/**
 * La lista de staff para el buscador (Ctrl+K).
 *
 * Sólo nombre, rango e id: lo mínimo para encontrar a alguien y abrir su
 * ficha. Nada de horas ni de montos. Y sólo para quien ya puede ver el staff:
 * a los demás se les contesta una lista vacía, no un error, porque el buscador
 * les sirve igual para moverse entre pantallas.
 */
export async function GET(): Promise<NextResponse> {
  const contexto = await getAuthContext();
  if (!contexto) return NextResponse.json({ ok: false }, { status: 401, headers: SIN_CACHE });

  // Con la contraseña temporal pendiente, tampoco: primero se cambia.
  if (!contexto.can(PERMISSIONS.STAFF_VIEW) || contexto.user.mustChangePassword) {
    return NextResponse.json({ ok: true, staff: [] }, { headers: SIN_CACHE });
  }

  const staff = await db
    .select({ id: staffMembers.id, name: staffMembers.name, rank: staffMembers.rank })
    .from(staffMembers)
    .where(isNull(staffMembers.archivedAt))
    .orderBy(asc(staffMembers.name))
    .limit(300);

  return NextResponse.json({ ok: true, staff }, { headers: SIN_CACHE });
}
