import { redirect } from "next/navigation";

import { LiveRefresh } from "@/components/layout/live-refresh";
import { AppShell } from "@/components/layout/shell";
import { CsrfProvider } from "@/components/ui/interactive";
import { getAuthContext } from "@/lib/auth/context";
import { csrfTokenFor } from "@/lib/auth/csrf";

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

  return (
    <CsrfProvider token={csrfTokenFor(context.session.id)}>
      <LiveRefresh />
      <AppShell viewer={context.viewer}>{children}</AppShell>
    </CsrfProvider>
  );
}
