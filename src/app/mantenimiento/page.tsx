import type { Metadata } from "next";

import { Coin } from "@/components/ui/coin";

export const metadata: Metadata = {
  title: "En mantenimiento",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * La pantalla de mantenimiento.
 *
 * Se enciende poniendo `MODO_MANTENIMIENTO=true` en el entorno; el filtro de
 * entrada manda todo acá menos los chequeos de salud, que son los que dicen
 * cuándo se puede volver a encender.
 *
 * Por qué tiene tanto trabajo encima una pantalla que casi nunca se ve: es la
 * única que alguien mira cuando algo anda mal, y es el momento exacto en que
 * uno duda de si el sistema entero se rompió o se perdieron sus horas. Una
 * página en blanco con "503 Service Unavailable" confirma el miedo. Ésta dice
 * que es a propósito, que los datos están donde estaban, y se mueve — lo que se
 * mueve se lee como vivo.
 *
 * No consulta la base ni ninguna otra cosa. Tiene que poder dibujarse
 * justamente cuando lo demás no responde.
 */
export default function MaintenancePage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      {/* Los anillos que se expanden detrás de la moneda: el latido de algo que
          sigue encendido aunque no atienda. */}
      <div aria-hidden className="mant-pulso">
        <span />
        <span />
        <span />
      </div>

      <div className="anim-rise relative w-full max-w-lg text-center">
        <Coin size={112} priority className="mx-auto mb-6" />

        <p className="mant-etiqueta">
          <span className="mant-punto" aria-hidden />
          Mantenimiento en curso
        </p>

        <h1 className="text-chalk-50 mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
          Volvemos en un rato
        </h1>

        <p className="text-chalk-400 mx-auto mt-3 max-w-md text-sm leading-relaxed">
          Estamos tocando algo del panel y lo bajamos a propósito para no dejarlo a medio camino.
          <br />
          <span className="text-chalk-200 font-semibold">
            No se perdió nada: las horas, los pagos y los fichajes están guardados
          </span>{" "}
          y van a estar igual cuando esto vuelva.
        </p>

        {/* Tres puntos que corren: lo único que se mueve arriba del pliegue. */}
        <div className="mant-barra" aria-hidden>
          <span />
        </div>

        <div className="mant-fichas">
          <div className="mant-ficha">
            <p className="mb-0 overline">Tus horas</p>
            <p className="text-chalk-200 mt-1 text-xs">Intactas</p>
          </div>
          <div className="mant-ficha">
            <p className="mb-0 overline">Fichajes</p>
            <p className="text-chalk-200 mt-1 text-xs">Se siguen contando</p>
          </div>
          <div className="mant-ficha">
            <p className="mb-0 overline">Pagos</p>
            <p className="text-chalk-200 mt-1 text-xs">Sin tocar</p>
          </div>
        </div>

        <p className="text-chalk-600 mt-8 text-xs leading-relaxed">
          Si necesitás algo urgente, avisale a <strong className="text-chalk-400">pit</strong> o a{" "}
          <strong className="text-chalk-400">mati</strong> por Discord.
          <br />
          Esta página se actualiza sola cuando el panel vuelve.
        </p>

        <p className="text-chalk-700 mt-7 text-[0.6875rem] tracking-[0.16em] uppercase">
          Imperio RP · Gestión de staff
        </p>
      </div>

      {/*
        Recarga sola cada treinta segundos.
        Es la diferencia entre que alguien descubra que el panel volvió, y que
        se quede mirando una pantalla vieja hasta que se le ocurra recargar.
        Va como `meta refresh` y no como script: esta pantalla tiene que
        funcionar aunque el JavaScript no cargue.
      */}
      <meta httpEquiv="refresh" content="30" />
    </main>
  );
}
