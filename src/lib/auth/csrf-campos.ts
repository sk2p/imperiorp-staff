/**
 * IMPERIO RP — Los nombres del token anti-CSRF.
 *
 * Van en un archivo aparte, sin nada más, porque los usa el navegador: cada
 * formulario manda el campo.
 *
 * Estaban en `csrf.ts`, que importa `node:crypto` para firmar el token. Un
 * componente del navegador que importaba nada más que el nombre del campo
 * arrastraba con él la emulación de `crypto` de Node entera: cientos de
 * kilobytes en cada carga, y adentro código que arma funciones a partir de
 * texto, que la política de seguridad de la página bloqueaba y Chrome marcaba
 * como problema.
 *
 * Ver `tests/sin-node-en-cliente.test.ts`, que impide que vuelva a pasar.
 */

export const CSRF_HEADER = "x-imperio-csrf";
export const CSRF_FIELD = "__csrf";
