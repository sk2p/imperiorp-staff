/**
 * IMPERIO RP — Freno de pedidos por origen.
 *
 * Esto NO reemplaza al limitador de intentos de acceso, que vive en la base y
 * cuenta contraseñas falladas por usuario. Esto es más abajo y más tonto: cuenta
 * pedidos por dirección IP, sin mirar quién es ni qué pide, y corta cuando una
 * sola dirección pasa de lo que cualquier persona podría generar con el mouse.
 *
 * Qué frena y qué no, para no vender lo que no es:
 *
 *   · Frena el caso real de un panel chico: alguien que descubre una URL y la
 *     machaca con un script, o un navegador enloquecido en bucle. Ahí evita que
 *     la base —el plan gratuito de Neon, con su cupo de horas de cómputo— se
 *     coma todo el mes en una tarde.
 *   · NO frena una inundación distribuida de miles de direcciones. Eso se ataja
 *     antes de llegar acá, en la red de Vercel/Cloudflare, y no hay código de
 *     aplicación que lo resuelva.
 *
 * El conteo vive en memoria y a propósito. Contra la base costaría una consulta
 * por pedido, que es exactamente el gasto del que uno se quiere defender. Lo
 * que se pierde es que cada instancia cuenta por su cuenta: con varias
 * instancias el tope efectivo se multiplica. Para el volumen de este panel
 * —cuarenta personas— es un intercambio que conviene.
 */

interface Ventana {
  /** Cuántos pedidos van en la ventana en curso. */
  cuenta: number;
  /** Cuándo se reinicia el conteo, en milisegundos epoch. */
  vence: number;
}

/**
 * Tope de direcciones vigiladas a la vez.
 *
 * Sin tope, el propio freno sería el agujero: un atacante que rota la IP de
 * cada pedido haría crecer el mapa sin límite hasta tumbar el proceso por
 * memoria. Al llenarse se descarta la mitad más vieja, que es justamente la que
 * ya no está pidiendo nada.
 */
const MAX_ORIGENES = 20_000;

const ventanas = new Map<string, Ventana>();

export interface Presupuesto {
  /** Cuántos pedidos se permiten dentro de la ventana. */
  readonly maximo: number;
  /** Cuánto dura la ventana, en milisegundos. */
  readonly ventanaMs: number;
}

export interface Veredicto {
  readonly permitido: boolean;
  /** Cuántos pedidos quedan en la ventana en curso. */
  readonly restantes: number;
  /** Segundos hasta que se libere, para la cabecera `Retry-After`. */
  readonly esperaSegundos: number;
}

function limpiarSiHaceFalta(ahora: number): void {
  if (ventanas.size < MAX_ORIGENES) return;

  for (const [clave, ventana] of ventanas) {
    if (ventana.vence <= ahora) ventanas.delete(clave);
  }

  // Si aun así sigue lleno —todas vigentes—, se vacía entero. Perder el conteo
  // es preferible a quedarse sin memoria; la ventana siguiente vuelve a contar.
  if (ventanas.size >= MAX_ORIGENES) ventanas.clear();
}

/**
 * Cuenta un pedido y dice si pasa.
 *
 * Ventana fija, no deslizante: es menos preciso en el borde —quien acierte el
 * cambio de ventana puede meter el doble en un instante— y a cambio es una
 * entrada de mapa y dos números por origen, sin listas de marcas de tiempo que
 * recorrer en cada pedido. Para frenar un script, alcanza.
 */
export function consumir(clave: string, presupuesto: Presupuesto): Veredicto {
  const ahora = Date.now();
  limpiarSiHaceFalta(ahora);

  const actual = ventanas.get(clave);

  if (!actual || actual.vence <= ahora) {
    ventanas.set(clave, { cuenta: 1, vence: ahora + presupuesto.ventanaMs });
    return { permitido: true, restantes: presupuesto.maximo - 1, esperaSegundos: 0 };
  }

  actual.cuenta += 1;

  if (actual.cuenta > presupuesto.maximo) {
    return {
      permitido: false,
      restantes: 0,
      esperaSegundos: Math.max(1, Math.ceil((actual.vence - ahora) / 1000)),
    };
  }

  return {
    permitido: true,
    restantes: presupuesto.maximo - actual.cuenta,
    esperaSegundos: 0,
  };
}

/** Sólo para los tests: deja el contador como recién arrancado. */
export function reiniciarFreno(): void {
  ventanas.clear();
}

/**
 * De dónde viene el pedido.
 *
 * Detrás de Vercel, `x-forwarded-for` trae la cadena de proxies y el PRIMERO es
 * el cliente real. Tomar el último daría siempre la misma dirección —la del
 * propio proxy— y el freno pasaría a contar a todo el mundo junto, cortándole a
 * cuarenta personas por culpa de una.
 *
 * La cabecera la puede inventar quien pida, pero Vercel reescribe la suya
 * encima antes de que llegue acá. Sin proxy delante —desarrollo— no hay
 * cabecera y todos caen en la misma clave, que en desarrollo es lo correcto.
 */
export function origenDe(headers: Headers): string {
  const reenviada = headers.get("x-forwarded-for");
  if (reenviada) {
    const primera = reenviada.split(",")[0]?.trim();
    if (primera) return primera;
  }

  return headers.get("x-real-ip")?.trim() || "desconocido";
}
