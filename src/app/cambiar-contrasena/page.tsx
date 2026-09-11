import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/app/(app)/perfil/password-form";
import { Icon } from "@/components/layout/icons";
import { CsrfProvider } from "@/components/ui/interactive";
import { Callout } from "@/components/ui/primitives";
import { getAuthContext } from "@/lib/auth/context";
import { csrfTokenFor } from "@/lib/auth/csrf";

export const metadata: Metadata = { title: "Cambiar contraseña" };
export const dynamic = "force-dynamic";

/**
 * Cambio obligatorio de contraseña.
 *
 * Vive fuera del grupo (app) a propósito: ese layout redirige acá cuando la
 * cuenta tiene el cambio pendiente, y si esta página estuviera adentro se
 * generaría un bucle de redirecciones.
 */
export default async function ForcedPasswordChangePage() {
  const context = await getAuthContext();
  if (!context) redirect("/ingresar");

  // Si ya la cambió, no tiene nada que hacer acá.
  if (!context.viewer.mustChangePassword) redirect("/");

  return (
    <CsrfProvider token={csrfTokenFor(context.session.id)}>
      <main className="flex min-h-dvh items-center justify-center px-4 py-10">
        <div className="anim-rise w-full max-w-md">
          <div className="mb-6 text-center">
            <span className="from-imperial-500 to-imperial-700 mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br text-white">
              <Icon name="lock" size={22} />
            </span>
            <h1 className="text-chalk-50 text-lg font-semibold tracking-tight">
              Cambiá tu contraseña
            </h1>
            <p className="text-chalk-500 mt-1 text-sm">
              Hola {context.viewer.displayName}, antes de entrar tenés que definir una contraseña
              propia.
            </p>
          </div>

          <div className="surface-raised overflow-hidden">
            <div className="p-4 pb-0">
              <Callout tone="warning">
                La contraseña actual es la temporal que te pasaron. Elegí una nueva que sólo vos
                conozcas.
              </Callout>
            </div>
            <ChangePasswordForm />
          </div>

          <form action="/api/salir" method="post" className="mt-4 text-center">
            <button
              type="submit"
              className="text-chalk-600 hover:text-imperial-400 text-xs font-semibold transition"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </main>
    </CsrfProvider>
  );
}
