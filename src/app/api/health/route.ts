import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Sonda de vida: responde si el proceso está en pie.
 *
 * No toca la base de datos a propósito. Un chequeo de vida que falla por una
 * caída momentánea de PostgreSQL hace que el orquestador reinicie un proceso
 * perfectamente sano. Para eso está `/api/ready`.
 */
export function GET(): NextResponse {
  return NextResponse.json(
    {
      status: "ok",
      service: "imperio-rp-staff",
      version: process.env.npm_package_version ?? "1.0.0",
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
