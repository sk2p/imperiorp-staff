import { describe, expect, it } from "vitest";

import { cleanText, optionalText, reasonSchema } from "@/validation/common";
import { setCellSchema, setStatusSchema } from "@/validation/grid";
import { z } from "zod";

/**
 * Cubre un fallo que llegó a producción: la planilla de horas no guardaba
 * ninguna casilla, y el error decía "expected nonoptional, received undefined"
 * sobre un campo que era opcional.
 *
 * La causa: `optionalText` aceptaba `undefined` como VALOR pero no marcaba la
 * CLAVE como opcional, así que omitir el campo del formulario lo rechazaba.
 */

describe("campos de texto opcionales", () => {
  const esquema = z.object({ nota: optionalText(200, "La nota") });

  it("acepta que la clave no esté presente", () => {
    const resultado = esquema.safeParse({});
    expect(resultado.success).toBe(true);
    expect(resultado.data?.nota).toBeNull();
  });

  it("acepta undefined explícito", () => {
    expect(esquema.parse({ nota: undefined }).nota).toBeNull();
  });

  it("normaliza la cadena vacía de un formulario HTML a null", () => {
    expect(esquema.parse({ nota: "" }).nota).toBeNull();
    expect(esquema.parse({ nota: "   " }).nota).toBeNull();
  });

  it("acepta null", () => {
    expect(esquema.parse({ nota: null }).nota).toBeNull();
  });

  it("conserva el texto y colapsa los espacios de más", () => {
    expect(esquema.parse({ nota: "  turno   noche  " }).nota).toBe("turno noche");
  });

  it("rechaza lo que supera el máximo", () => {
    expect(esquema.safeParse({ nota: "x".repeat(201) }).success).toBe(false);
  });
});

describe("la planilla guarda sin mandar campos de más", () => {
  const base = {
    weekId: "3f4a1b2c-1111-4222-8333-444455556666",
    staffMemberId: "3f4a1b2c-1111-4222-8333-444455556667",
  };

  it("acepta una casilla sin nota, que es como la manda la grilla", () => {
    const resultado = setCellSchema.safeParse({
      ...base,
      workDate: "2026-09-05",
      minutes: "150",
    });

    expect(resultado.success).toBe(true);
    expect(resultado.data?.minutes).toBe(150);
    expect(resultado.data?.note).toBeNull();
  });

  it("acepta cero, que es como se borra una casilla", () => {
    expect(setCellSchema.safeParse({ ...base, workDate: "2026-09-05", minutes: "0" }).success).toBe(
      true,
    );
  });

  it("rechaza más de 24 horas en un día", () => {
    expect(
      setCellSchema.safeParse({ ...base, workDate: "2026-09-05", minutes: "1441" }).success,
    ).toBe(false);
  });

  it("rechaza una fecha que no existe", () => {
    expect(
      setCellSchema.safeParse({ ...base, workDate: "2026-02-30", minutes: "60" }).success,
    ).toBe(false);
  });

  it("acepta un cambio de estado sin nota", () => {
    const resultado = setStatusSchema.safeParse({ ...base, status: "justificado" });
    expect(resultado.success).toBe(true);
    expect(resultado.data?.note).toBeNull();
  });

  it("rechaza un estado inventado", () => {
    expect(setStatusSchema.safeParse({ ...base, status: "vacaciones" }).success).toBe(false);
  });
});

describe("campos de texto obligatorios", () => {
  const esquema = z.object({ nombre: cleanText(2, 40, "El nombre") });

  it("exige que la clave esté presente", () => {
    expect(esquema.safeParse({}).success).toBe(false);
  });

  it("recorta y colapsa espacios antes de medir la longitud", () => {
    expect(esquema.parse({ nombre: "  Martin  " }).nombre).toBe("Martin");
    expect(esquema.safeParse({ nombre: "  a  " }).success).toBe(false);
  });

  it("el motivo rechaza relleno sin contenido", () => {
    expect(reasonSchema.safeParse("Faltaban dos horas del sábado.").success).toBe(true);
    expect(reasonSchema.safeParse("asdasd").success).toBe(false);
    expect(reasonSchema.safeParse("....").success).toBe(false);
    expect(reasonSchema.safeParse("test").success).toBe(false);
  });
});
