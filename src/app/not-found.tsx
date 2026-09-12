import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

export const metadata: Metadata = { title: "Página no encontrada" };

/**
 * La pantalla de "acá no hay nada".
 *
 * Next trae una por defecto que es un texto negro sobre blanco: rompe el tema
 * entero y parece que la aplicación se cayó. Alguien que se equivoca de enlace
 * merece entender qué pasó y tener el camino de vuelta a mano.
 */
export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 left-1/2 -translate-x-1/2 opacity-[0.05] blur-[1px]"
      >
        <Image src="/imperiorplogo.webp" alt="" width={520} height={520} />
      </div>

      <div className="anim-rise relative w-full max-w-md text-center">
        <p className="error-numero select-none">404</p>

        <h1 className="text-chalk-50 -mt-4 text-xl font-bold tracking-tight sm:text-2xl">
          Acá no hay nada
        </h1>
        <p className="text-chalk-500 mx-auto mt-2 max-w-sm text-sm leading-relaxed">
          La página que buscabas no existe, o se movió de lugar. Si llegaste desde un enlace de
          adentro del panel, avisale a pit o a mati.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
          <Link href="/" className="btn btn-primary">
            Volver al inicio
          </Link>
          <Link href="/horas" className="btn">
            Ir a la planilla
          </Link>
        </div>

        <p className="text-chalk-700 mt-8 text-[0.6875rem] tracking-[0.16em] uppercase">
          Imperio RP · Gestión de staff
        </p>
      </div>
    </main>
  );
}
