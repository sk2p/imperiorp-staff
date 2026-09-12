import { describe, expect, it } from "vitest";

import {
  AppError,
  businessRule,
  conflict,
  internal,
  isAppError,
  isTransientDatabaseError,
  pgErrorCode,
  rateLimited,
  serializeError,
  unauthenticated,
  validation,
} from "@/lib/core/errors";

/**
 * Estas pruebas cubren un fallo real que llegó a producción: la pantalla de
 * acceso mostró la consulta SQL completa, con nombres de tablas y columnas, a
 * un visitante sin autenticar. La causa fue devolver `error.message` de
 * cualquier excepción en vez de pasar por la serialización.
 *
 * La regla que se verifica acá es una sola: al cliente sólo llega el texto de
 * un `AppError`, que está escrito a propósito para que lo lea una persona.
 */

describe("no se filtra información interna al cliente", () => {
  it("nunca expone el mensaje de un Error corriente", () => {
    const interno = new Error(
      'Failed query: insert into "login_attempts" ("id", "bucket_key") values ($1, $2)',
    );

    const salida = serializeError(interno, "abc123");

    expect(salida.message).not.toContain("login_attempts");
    expect(salida.message).not.toContain("insert into");
    expect(salida.message).not.toContain("$1");
    expect(salida.code).toBe("INTERNAL");
  });

  it("tampoco expone errores del driver de PostgreSQL", () => {
    const pgError = Object.assign(new Error('relation "users" does not exist'), {
      code: "42P01",
      severity: "ERROR",
    });

    const salida = serializeError(pgError);

    expect(salida.message).not.toContain("users");
    expect(salida.message).not.toContain("42P01");
  });

  it("oculta el detalle incluso si el error trae una cadena de causas", () => {
    const raiz = new Error('password authentication failed for user "neondb_owner"');
    const envuelto = new Error("connection error", { cause: raiz });

    const salida = serializeError(envuelto);

    expect(salida.message).not.toContain("neondb_owner");
    expect(salida.message).not.toContain("password");
  });

  it("no filtra valores lanzados que no son Error", () => {
    for (const raro of ["secreto en texto plano", { token: "abc" }, 42, null, undefined]) {
      const salida = serializeError(raro);
      expect(salida.code).toBe("INTERNAL");
      expect(salida.message).toBe("Ocurrió un error interno. El equipo fue notificado.");
    }
  });

  it("sí muestra el mensaje de un AppError, que se escribió para el usuario", () => {
    const salida = serializeError(businessRule("El período ya está cerrado."));

    expect(salida.message).toBe("El período ya está cerrado.");
    expect(salida.code).toBe("BUSINESS_RULE");
  });

  it("mantiene el contexto interno fuera de la respuesta", () => {
    const error = conflict("Ya hay un pago registrado.", {
      context: { consultaInterna: "select * from payments", usuario: "pit" },
    });

    const serializado = JSON.stringify(serializeError(error));

    expect(serializado).not.toContain("select * from payments");
    expect(serializado).not.toContain("pit");
    expect(serializado).toContain("Ya hay un pago registrado.");
  });

  it("entrega el traceId sólo en errores internos, para poder buscarlos en los logs", () => {
    expect(serializeError(internal(), "traza-1").traceId).toBe("traza-1");
    // Un error de negocio no necesita traza: el mensaje ya lo explica.
    expect(serializeError(businessRule("Sin horas."), "traza-1").traceId).toBeUndefined();
  });
});

describe("comportamiento de los errores tipados", () => {
  it("asigna el código HTTP correcto a cada clase de error", () => {
    expect(unauthenticated().status).toBe(401);
    expect(validation("campos inválidos").status).toBe(422);
    expect(conflict("duplicado").status).toBe(409);
    expect(rateLimited("muchos intentos", 900).status).toBe(429);
    expect(businessRule("regla").status).toBe(400);
    expect(internal().status).toBe(500);
  });

  it("conserva los errores por campo para mostrarlos en el formulario", () => {
    const error = validation("Revisá los datos.", { amount: ["Tiene que ser mayor a cero."] });
    expect(serializeError(error).details?.amount).toEqual(["Tiene que ser mayor a cero."]);
  });

  it("informa cuántos segundos hay que esperar tras un bloqueo", () => {
    expect(serializeError(rateLimited("Bloqueado.", 900)).retryAfterSeconds).toBe(900);
  });

  it("distingue un AppError de cualquier otra excepción", () => {
    expect(isAppError(new AppError("CONFLICT", "x"))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe("errores pasajeros de la base", () => {
  it("reconoce los códigos de PostgreSQL de conexión caída", () => {
    for (const code of ["08000", "08003", "08006", "57P01", "57P03"]) {
      expect(isTransientDatabaseError({ code })).toBe(true);
    }
  });

  it("reconoce los errores de red de Node", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED"]) {
      expect(isTransientDatabaseError({ code })).toBe(true);
    }
  });

  it("los encuentra aunque vengan envueltos por el driver", () => {
    // Drizzle y PGlite envuelven el error original en `cause`.
    expect(isTransientDatabaseError({ cause: { code: "ECONNRESET" } })).toBe(true);
    expect(isTransientDatabaseError({ cause: { cause: { code: "08006" } } })).toBe(true);
  });

  it("reconoce los mensajes típicos de pg cuando no hay código", () => {
    expect(isTransientDatabaseError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(
      isTransientDatabaseError(new Error("timeout exceeded when trying to connect")),
    ).toBe(true);
  });

  it("NO confunde un error de verdad con uno pasajero", () => {
    // Éstos son bugs o violaciones de reglas: reintentarlos falla igual, y
    // tratarlos como pasajeros escondería el problema real.
    expect(isTransientDatabaseError({ code: "23505" })).toBe(false); // índice único
    expect(isTransientDatabaseError({ code: "42703" })).toBe(false); // columna inexistente
    expect(isTransientDatabaseError({ code: "40001" })).toBe(false); // serialización
    expect(isTransientDatabaseError(new Error("algo salió mal"))).toBe(false);
    expect(isTransientDatabaseError(null)).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });
});

describe("el código SQLSTATE, esté donde esté", () => {
  it("lo encuentra arriba de todo y envuelto", () => {
    expect(pgErrorCode({ code: "23505" })).toBe("23505");
    expect(pgErrorCode({ cause: { code: "23505" } })).toBe("23505");
    expect(pgErrorCode({ cause: { cause: { code: "42703" } } })).toBe("42703");
  });

  it("ignora lo que no tenga forma de SQLSTATE", () => {
    // Un `code` de Node como ECONNRESET no es un SQLSTATE: cinco caracteres
    // alfanuméricos en mayúscula. Confundirlos haría que un error de red se
    // tratara como un error de PostgreSQL.
    expect(pgErrorCode({ code: "ECONNRESET" })).toBe(null);
    expect(pgErrorCode({ code: 23505 })).toBe(null);
    expect(pgErrorCode({})).toBe(null);
    expect(pgErrorCode(null)).toBe(null);
  });
});
