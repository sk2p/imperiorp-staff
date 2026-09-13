import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/lib/auth/context";
import { assertSameOrigin } from "@/lib/auth/csrf";
import { httpStatusFor, serializeError } from "@/lib/core/errors";
import { performLogout } from "@/server/auth-flow";

/** Cierre de sesión. Sólo POST: un GET lo dispararía cualquier `<img>` remoto. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  /**
   * Desde otro sitio se contesta 403, no 500.
   *
   * La excepción salía sin atrapar y Next respondía "error interno": el pedido
   * quedaba rechazado igual, pero los logs anotaban una falla del servidor por
   * cada intento, que es ruido justo donde hay que mirar.
   */
  try {
    assertSameOrigin(request);
  } catch (error) {
    return NextResponse.json(serializeError(error), { status: httpStatusFor(error) });
  }

  const context = await getAuthContext();
  await performLogout({
    ip: context?.actor.ip,
    username: context?.actor.username,
  });

  return NextResponse.redirect(new URL("/ingresar", request.url), { status: 303 });
}
