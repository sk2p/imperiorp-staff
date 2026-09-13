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
 * El primer número que puse —ciento veinte lecturas— saltaba con uso normal, y
 * lo descubrí navegando yo mismo. Una página de este panel no es UN pedido:
 * navegar trae la vista del servidor, la pantalla se refresca sola cada doce
 * segundos, y con dos o tres pestañas abiertas eso se multiplica. Un freno que
 * corta a quien está trabajando es peor que no tener freno: lo primero que
 * pasa es que alguien lo apaga.
 *
 * Trescientas por minuto son cinco por segundo sostenidos. Ninguna persona
 * llega ahí moviendo el mouse, y un script que machaca una URL lo pasa en el
 * primer segundo.
 *
 * Escribir es otra cosa: un formulario, un pago, una casilla de la planilla.
 * Nadie hace sesenta en un minuto a mano, y cada una cuesta una transacción.
 */
const FRENO_LECTURA = { maximo: 300, ventanaMs: 60_000 } as const;
const FRENO_ESCRITURA = { maximo: 60, ventanaMs: 60_000 } as const;

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

    /**
     * En desarrollo el freno se afloja diez veces.
     *
     * Sin un proxy adelante no hay cabecera que diga de dónde viene el pedido,
     * así que TODO cae en la misma clave: el navegador, las herramientas, las
     * recargas en caliente de Next. Con el presupuesto de producción, cortarse
     * a uno mismo mientras se trabaja es cuestión de minutos —me pasó dos
     * veces—, y un freno que estorba es un freno que alguien termina sacando.
     *
     * El camino se sigue ejecutando igual, así que si se rompe, se rompe acá y
     * no en producción.
     */
    const holgura = process.env.NODE_ENV === "production" ? 1 : 10;

    const veredicto = consumir(origenDe(request.headers) + ":" + (escribe ? "w" : "r"), {
      maximo: presupuesto.maximo * holgura,
      ventanaMs: presupuesto.ventanaMs,
    });

    if (!veredicto.permitido) {
      /**
       * La respuesta se devuelve en HTML y no en texto pelado: esto puede caer
       * en medio de una navegación, y un navegador mostrando texto plano sobre
       * fondo blanco parece que el sistema explotó. Va mínima y sin depender de
       * nada: el punto de frenar es no gastar recursos.
       *
       * El reintento espera la ventana COMPLETA más tres segundos. Con el
       * tiempo justo, la página se recarga en el instante exacto en que la
       * ventana se renueva, consume el primer pedido de la nueva y, si además
       * hay otras pestañas haciendo lo mismo, vuelve a chocar: un bucle que se
       * mantiene a sí mismo bloqueado. Me pasó probándolo.
       */
      const respuesta = new NextResponse(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
          "<title>Demasiados pedidos</title>" +
          '<meta http-equiv="refresh" content="' +
          (veredicto.esperaSegundos + 3) +
          '">' +
          "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080a;" +
          "color:#e8e9ec;font:15px/1.6 system-ui,sans-serif;text-align:center;padding:24px}" +
          "p{color:#8b8f98;font-size:13px;margin:.5rem 0 0}</style>" +
          "<div><strong>Frená un toque</strong>" +
          "<p>Llegaron demasiados pedidos desde esta conexión.<br>Esto se reintenta solo en " +
          veredicto.esperaSegundos +
          " segundos.</p></div>",
        { status: 429, headers: { "Content-Type": "text/html; charset=utf-8" } },
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
