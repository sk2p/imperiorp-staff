import { redirect } from "next/navigation";

import { CommandPalette } from "@/components/layout/command-palette";
import { LiveRefresh } from "@/components/layout/live-refresh";
import { visibleItems } from "@/components/layout/navigation";
import { AppShell } from "@/components/layout/shell";
import { CsrfProvider } from "@/components/ui/interactive";
import { getAuthContext } from "@/lib/auth/context";
import { csrfTokenFor } from "@/lib/auth/csrf";
import { firmaDeDatos } from "@/server/firma";

/**
 * Puerta de entrada de todas las pantallas internas.
 *
 * Acá la sesión se valida de verdad contra la base de datos. El middleware sólo
 * miró si existía una cookie; este layout comprueba que sea válida, vigente y
 * de una cuenta activa antes de renderizar nada.
 */
export default async function AppLayout({ children }: { readonly children: React.ReactNode }) {
  const context = await getAuthContext();

  if (!context) redirect("/ingresar");

  // Con la contraseña marcada para cambio no se accede a ninguna otra pantalla.
  if (context.viewer.mustChangePassword) redirect("/cambiar-contrasena");

  /**
   * La firma de lo que se va a mostrar, calculada en el mismo pedido.
   *
   * Si la calculara el navegador al cargar, un cambio que cayera entre el
   * render y esa primera pregunta quedaría adentro de la firma "vieja" y no se
   * vería hasta el redibujo completo. Si falla, la pantalla se muestra igual:
   * el refresco se arregla solo con la primera firma que consiga.
   */
  const firma = await firmaDeDatos().catch(() => null);

  // Las mismas pantallas que muestra el menú: el buscador no abre puertas nuevas.
  const pantallas = visibleItems(
    context.viewer.permissions,
    context.viewer.role === "OWNER",
    context.viewer.role === "FOUNDER",
  ).flatMap((grupo) => grupo.items);

  return (
    <CsrfProvider token={csrfTokenFor(context.session.id)}>
      <LiveRefresh firma={firma} />
      <CommandPalette items={pantallas} permisos={context.viewer.permissions} />
      <AppShell viewer={context.viewer}>{children}</AppShell>
    </CsrfProvider>
  );
}
