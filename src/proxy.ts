import { NextResponse, type NextRequest } from "next/server";

import { consumir, origenDe } from "@/lib/core/throttle";

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
const MANTENIMIENTO_PATH = "/mantenimiento";

/**
 * Cuánto puede pedir una misma dirección por minuto.
 *
 * Los números salen de lo que hace una persona de verdad: la pantalla se
 * refresca sola cada doce segundos —cinco por minuto— y navegar entre
 * secciones agrega unos pocos. Ciento veinte deja lugar para varias pestañas
 * abiertas y sigue cortando a un script mucho antes de que la base lo note.
 *
 * Escribir es otra cosa: un formulario, un pago, una casilla de la planilla.
 * Nadie hace cuarenta en un minuto a mano, y cada uno cuesta una transacción.
 */
const FRENO_LECTURA = { maximo: 120, ventanaMs: 60_000 } as const;
const FRENO_ESCRITURA = { maximo: 40, ventanaMs: 60_000 } as const;

/**
 * El acceso tiene su propio freno, mucho más corto.
 *
 * El limitador de la base cuenta contraseñas falladas por usuario y bloquea la
 * cuenta; esto corta antes, por dirección, para que probar diez mil
 * contraseñas ni siquiera llegue a consultar la base diez mil veces.
 */
const FRENO_ACCESO = { maximo: 12, ventanaMs: 60_000 } as const;

/** Rutas accesibles sin sesión. */
const PUBLIC_PATHS = new Set([LOGIN_PATH, MANTENIMIENTO_PATH, "/api/health", "/api/ready"]);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return (
    /**
     * Las tareas programadas no tienen cookie: las llama el programador de
     * Vercel, no un navegador. Sin esta excepción el filtro las redirige al
     * login y la rotación del período no corre nunca.
     *
     * No queda abierto nada: cada tarea exige el secreto compartido en la
     * cabecera `Authorization`, y sin `CRON_SECRET` definida se cierra sola
     * en producción.
     */
    pathname.startsWith("/api/cron/") ||
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

/**
 * El modo mantenimiento se enciende con una variable de entorno.
 *
 * No se guarda en la base a propósito: si se cae la base —que es el motivo más
 * probable para poner el panel en mantenimiento—, una bandera guardada ahí no
 * se podría leer justo cuando hace falta.
 */
function enMantenimiento(): boolean {
  const valor = process.env.MODO_MANTENIMIENTO?.trim().toLowerCase();
  return valor === "1" || valor === "true" || valor === "si";
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = crypto.randomUUID().replace(/-/g, "");

  /**
   * El freno va primero, antes de cualquier otra cosa.
   *
   * Un pedido rechazado acá no toca la base, no renderiza nada y no gasta más
   * que una entrada en un mapa. Ponerlo después de la comprobación de sesión
   * sería dejar que la avalancha llegue justamente a lo que cuesta plata.
   */
  if (!pathname.startsWith("/_next/") && pathname !== "/api/health") {
    const escribe = request.method !== "GET" && request.method !== "HEAD";
    const presupuesto = pathname.startsWith(LOGIN_PATH)
      ? FRENO_ACCESO
      : escribe
        ? FRENO_ESCRITURA
        : FRENO_LECTURA;

    const veredicto = consumir(
      origenDe(request.headers) + ":" + (escribe ? "w" : "r"),
      presupuesto,
    );

    if (!veredicto.permitido) {
      const respuesta = new NextResponse(
        "Demasiados pedidos. Probá de nuevo en " + veredicto.esperaSegundos + " segundos.",
        { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
      respuesta.headers.set("Retry-After", String(veredicto.esperaSegundos));
      return securityHeaders(respuesta as NextResponse, nonce);
    }
  }

  /**
   * Mantenimiento: todo va a la misma pantalla, menos los chequeos de salud
   * —que son los que dicen si ya se puede volver a encender— y los archivos
   * estáticos que esa pantalla necesita para verse.
   */
  if (
    enMantenimiento() &&
    pathname !== MANTENIMIENTO_PATH &&
    pathname !== "/api/health" &&
    pathname !== "/api/ready" &&
    !pathname.startsWith("/_next/") &&
    !pathname.startsWith("/favicon")
  ) {
    const destino = request.nextUrl.clone();
    destino.pathname = MANTENIMIENTO_PATH;
    destino.search = "";

    const respuesta = NextResponse.rewrite(destino);
    // 503 con Retry-After: los buscadores entienden que es temporal y no
    // borran la página de su índice.
    respuesta.headers.set("Retry-After", "600");
    return securityHeaders(respuesta, nonce);
  }

  // Fuera de mantenimiento, la pantalla de mantenimiento no existe.
  if (!enMantenimiento() && pathname === MANTENIMIENTO_PATH) {
    const destino = request.nextUrl.clone();
    destino.pathname = "/";
    destino.search = "";
    return securityHeaders(NextResponse.redirect(destino), nonce);
  }

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
