import crypto from "node:crypto";

/**
 * Comparar un secreto compartido sin dar pistas con el tiempo de respuesta.
 *
 * `recibido === esperado` corta en el primer carácter distinto, así que en
 * teoría quien mide cuánto tarda la respuesta puede ir adivinando el secreto de
 * a un carácter. Por internet es muy difícil de aprovechar, pero evitarlo
 * cuesta dos líneas.
 *
 * Se comparan los SHA-256 y no los textos: `timingSafeEqual` exige el mismo
 * largo, y cortar antes cuando el largo difiere le diría a quien prueba cuánto
 * mide el secreto.
 */
export function coincideSecreto(recibido: string | null | undefined, esperado: string): boolean {
  if (typeof recibido !== "string" || esperado.length === 0) return false;

  const a = crypto.createHash("sha256").update(recibido).digest();
  const b = crypto.createHash("sha256").update(esperado).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * `Authorization: Bearer <secreto>`. Sin secreto configurado no autoriza a nadie.
 *
 * El secreto no se recorta: Vercel manda el valor tal cual está guardado, y
 * recortarlo de este lado haría fallar la comparación si quedó con un espacio.
 */
export function portadorValido(authorization: string | null, secreto: string | undefined): boolean {
  if (!secreto) return false;
  return coincideSecreto(authorization, "Bearer " + secreto);
}
