import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { performLogout } from "@/server/auth-flow";

/** Cierre de sesión. Sólo POST: un GET lo dispararía cualquier `<img>` remoto. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  assertSameOrigin(request);

  const context = await getAuthContext();
  await performLogout({
    ip: context?.actor.ip,
    username: context?.actor.username,
  });

  return NextResponse.redirect(new URL("/ingresar", request.url), { status: 303 });
}
