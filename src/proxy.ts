import { NextResponse, type NextRequest } from "next/server";

/**
 * Primera línea de defensa: cabeceras de seguridad y un filtro barato de acceso.
 *
 * IMPORTANTE: el middleware corre en el runtime Edge, sin acceso a la base de
 * datos. Sólo mira SI HAY cookie de sesión, no si es válida. La verificación
 * real ocurre en el servidor, en `requireAuth()`, antes de cada consulta y cada
 * acción. Nadie entra a nada por tener una cookie inventada; esto únicamente
 * evita renderizar pantallas que igual terminarían rechazadas.
 */

const SESSION_COOKIE = "imperio_session";
const LOGIN_PATH = "/ingresar";

/** Rutas accesibles sin sesión. */
const PUBLIC_PATHS = new Set([LOGIN_PATH, "/api/health", "/api/ready"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/manifest.webmanifest"
  );
}

function securityHeaders(response: NextResponse, nonce: string): NextResponse {
  const headers = response.headers;

  /**
   * CSP estricta. `'strict-dynamic'` con nonce permite los scripts que emite
   * Next.js y bloquea cualquier otro, que es la defensa de fondo contra XSS:
   * aunque alguien lograra inyectar una etiqueta script, el navegador no la
   * ejecuta sin el nonce del servidor.
   *
   * `'unsafe-inline'` queda como respaldo para navegadores que no entienden
   * nonces; los que sí lo entienden lo ignoran por completo.
   */
  // React en modo desarrollo usa eval() para reconstruir pilas de llamadas.
  // En producción nunca lo hace, así que el permiso se otorga sólo en dev.
  const devEval = process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'";

  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'nonce-" +
        nonce +
        "' 'strict-dynamic' 'unsafe-inline'" +
        devEval +
        " https:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-DNS-Prefetch-Control", "off");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");

  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = crypto.randomUUID().replace(/-/g, "");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (!isPublic(pathname) && !hasSessionCookie) {
    const target = request.nextUrl.clone();
    target.pathname = LOGIN_PATH;
    // Se conserva el destino para volver ahí tras iniciar sesión.
    target.search = pathname === "/" ? "" : "?destino=" + encodeURIComponent(pathname + search);
    return securityHeaders(NextResponse.redirect(target), nonce);
  }

  /**
   * NO se redirige desde /ingresar aunque haya cookie.
   *
   * Acá sólo se ve SI EXISTE la cookie, no si sigue siendo válida: una sesión
   * revocada o vencida deja el navegador con una cookie muerta. Si esa cookie
   * rebotara al usuario de /ingresar a /, y / lo devolviera a /ingresar por no
   * tener sesión real, quedaría atrapado en un bucle sin poder entrar nunca.
   * Esa decisión la toma la página de acceso, que sí consulta la base.
   */

  return securityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
