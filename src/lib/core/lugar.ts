/**
 * IMPERIO RP — De dónde viene un pedido, en palabras: "Córdoba, AR".
 *
 * Vercel agrega la ubicación aproximada de la IP en cabeceras propias. No es
 * exacta —es la de la conexión, no la de la persona—, pero alcanza para que
 * alguien que vive en Rosario vea "Madrid, ES" en un aviso de acceso y se dé
 * cuenta de que ese no fue él.
 *
 * El texto termina en un mensaje de Discord, así que se limpia: un nombre con
 * corchetes o asteriscos armaría un enlace o rompería el formato del aviso.
 * Fuera de Vercel no hay cabeceras y no hay lugar, que es lo correcto.
 */

function decodificar(valor: string | null): string {
  if (!valor) return "";
  try {
    // La ciudad llega codificada para URL: "S%C3%A3o%20Paulo".
    return decodeURIComponent(valor);
  } catch {
    return valor;
  }
}

function limpiar(texto: string, largo: number): string {
  return texto
    .replace(/[^\p{L}\p{N} .'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, largo);
}

export function lugarDeVercel(leer: (nombre: string) => string | null): string | undefined {
  const ciudad = limpiar(decodificar(leer("x-vercel-ip-city")), 60);
  const pais = limpiar(decodificar(leer("x-vercel-ip-country")), 2).toUpperCase();

  const partes = [ciudad, pais].filter((parte) => parte.length > 0);
  return partes.length > 0 ? partes.join(", ") : undefined;
}
