import { after } from "next/server";

/**
 * Una tarea que sale después de contestar.
 *
 * `after` hace que la respuesta al navegador no espere a la tarea, y que la
 * función de Vercel no se corte antes de terminarla, que es lo que le puede
 * pasar a una promesa suelta.
 *
 * `after` sólo funciona dentro de un pedido. Fuera de uno —un script, un test—
 * lanza, y ahí alcanza con dispararla suelta.
 */
export function enSegundoPlano(tarea: () => Promise<void>): void {
  try {
    after(tarea);
  } catch {
    void tarea();
  }
}
