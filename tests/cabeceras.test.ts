import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";

import { reiniciarFreno } from "@/lib/core/throttle";
import { proxy } from "@/proxy";

/**
 * Las cabeceras de seguridad, tal como salen del proxy.
 *
 * La `Permissions-Policy` pedía `interest-cohort=()`, el bloqueo de FLoC.
 * Chrome retiró FLoC y dejó de reconocer ese nombre, así que la cabecera
 * aparecía como error en la consola de cada pantalla. No rompía nada, pero es
 * ruido que tapa los errores que sí importan, y un bloqueo que ya no bloqueaba.
 *
 * Este test fija dos cosas: que cada función de la política sea una que los
 * navegadores reconocen hoy, y que las que importan sigan cerradas.
 */

/** Funciones de `Permissions-Policy` que Chrome reconoce, entre las que usamos. */
const RECONOCIDAS = new Set([
  "camera",
  "microphone",
  "geolocation",
  "payment",
  "usb",
  "browsing-topics",
  "fullscreen",
  "display-capture",
]);

/** Retiradas: con estas Chrome escribe "Unrecognized feature" en la consola. */
const RETIRADAS = ["interest-cohort", "document-domain", "vr", "speaker", "vibrate"];

function politica(): string {
  const respuesta = proxy(new NextRequest("http://localhost/ingresar"));
  return respuesta.headers.get("Permissions-Policy") ?? "";
}

describe("Permissions-Policy", () => {
  beforeEach(() => {
    reiniciarFreno();
  });

  it("sólo usa funciones que el navegador reconoce", () => {
    const funciones = politica()
      .split(",")
      .map((parte) => parte.trim().split("=")[0]!)
      .filter(Boolean);

    expect(funciones.length).toBeGreaterThan(0);
    expect(funciones.filter((funcion) => !RECONOCIDAS.has(funcion))).toEqual([]);
    for (const retirada of RETIRADAS) expect(funciones).not.toContain(retirada);
  });

  it("sigue cerrando cámara, micrófono, ubicación y el perfilado de intereses", () => {
    const texto = politica();
    for (const cerrada of ["camera=()", "microphone=()", "geolocation=()", "browsing-topics=()"]) {
      expect(texto).toContain(cerrada);
    }
  });
});
