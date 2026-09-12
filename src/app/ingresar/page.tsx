import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";

import { getAuthContext } from "@/lib/auth/context";
import { Coin } from "@/components/ui/coin";
import { Spotlight } from "@/components/ui/spotlight";
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
      <Spotlight />

      {/* Marca de agua: una corona enorme, recortada, muy tenue. Da identidad
          sin competir con el formulario. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 opacity-[0.045] blur-[1px]"
      >
        <Image src="/imperiorplogo.webp" alt="" width={560} height={560} />
      </div>

      <div className="anim-rise relative w-full max-w-[23rem]">
        <div className="mb-7 text-center">
          <Coin size={104} priority className="anim-rise mx-auto mb-4" />
          <h1 className="text-chalk-50 text-lg font-bold tracking-[0.18em]">IMPERIO RP</h1>
          <p className="text-chalk-600 mt-1 text-[0.6875rem] font-semibold tracking-[0.2em] uppercase">
            Gestión de staff
          </p>
        </div>

        <div className="surface-raised borde-vivo p-5 sm:p-6">
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
