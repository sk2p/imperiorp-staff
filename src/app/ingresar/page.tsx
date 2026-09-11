import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Icon } from "@/components/layout/icons";
import { getAuthContext } from "@/lib/auth/context";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Ingresar" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ destino?: string }>;
}) {
  const params = await searchParams;

  /**
   * Comprobación real contra la base: si la sesión existe y sigue viva, no hace
   * falta volver a entrar. Una cookie vencida o revocada, en cambio, deja pasar
   * al formulario en vez de rebotar al usuario.
   */
  const context = await getAuthContext();
  if (context) redirect(context.viewer.mustChangePassword ? "/cambiar-contrasena" : "/");

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      {/* Marca de agua: una corona enorme, recortada, muy tenue. Da identidad
          sin competir con el formulario. */}
      <div
        aria-hidden
        className="text-imperial-500/[0.045] pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2"
      >
        <Icon name="crown" size={520} />
      </div>

      <div className="anim-rise relative w-full max-w-[23rem]">
        <div className="mb-7 text-center">
          <span className="anim-ring from-imperial-500 to-imperial-700 mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-[0_8px_28px_-8px_rgb(229_22_44/0.9)]">
            <Icon name="crown" size={24} />
          </span>
          <h1 className="text-chalk-50 text-lg font-bold tracking-[0.18em]">IMPERIO RP</h1>
          <p className="text-chalk-600 mt-1 text-[0.6875rem] font-semibold tracking-[0.2em] uppercase">
            Gestión de staff
          </p>
        </div>

        <div className="surface-raised p-5 sm:p-6">
          <LoginForm redirectTo={params.destino ?? null} />
        </div>

        <p className="text-chalk-600 mt-5 text-center text-[0.6875rem] leading-relaxed">
          Acceso restringido al staff autorizado.
          <br />
          Todos los ingresos quedan registrados.
        </p>
      </div>
    </main>
  );
}
