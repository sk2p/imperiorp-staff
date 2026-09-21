import { describe, expect, it } from "vitest";

import { obtenerRangoStaffDeRoles, STAFF_ROLE_MAP } from "@/bot/roles";

describe("Sincronización de roles de staff desde Discord", () => {
  it("contiene todos los roles especificados con sus rangos respectivos", () => {
    expect(STAFF_ROLE_MAP["945562965787156500"]).toBe("SDP");
    expect(STAFF_ROLE_MAP["945562697993420813"]).toBe("SP");
    expect(STAFF_ROLE_MAP["945562075252555846"]).toBe("SE");
    expect(STAFF_ROLE_MAP["945561723639836703"]).toBe("MOD");
    expect(STAFF_ROLE_MAP["1114968517683450036"]).toBe("MOD+");
    expect(STAFF_ROLE_MAP["945561389097955378"]).toBe("MOD++");
    expect(STAFF_ROLE_MAP["945560648941715506"]).toBe("ADM");
    expect(STAFF_ROLE_MAP["945560343256657950"]).toBe("ADM+");
    expect(STAFF_ROLE_MAP["945560068986912808"]).toBe("ADM++");
    expect(STAFF_ROLE_MAP["1298421134278262835"]).toBe("SUBDG");
    expect(STAFF_ROLE_MAP["945559013603545098"]).toBe("DG");
  });

  it("devuelve null si el usuario no tiene ningún rol de staff", () => {
    const roles = ["123456789012345678", "987654321098765432"];
    expect(obtenerRangoStaffDeRoles(roles)).toBeNull();
  });

  it("devuelve el rango correspondiente cuando tiene un único rol", () => {
    expect(obtenerRangoStaffDeRoles(["945562965787156500"])).toBe("SDP");
    expect(obtenerRangoStaffDeRoles(["945560648941715506"])).toBe("ADM");
    expect(obtenerRangoStaffDeRoles(["945559013603545098"])).toBe("DG");
  });

  it("si tiene varios roles toma en cuenta el de jerarquía más alta", () => {
    // SDP (tier 1) + MOD (tier 4) -> MOD
    expect(obtenerRangoStaffDeRoles(["945562965787156500", "945561723639836703"])).toBe("MOD");

    // SP (tier 2) + ADM++ (tier 9) + MOD+ (tier 5) -> ADM++
    expect(
      obtenerRangoStaffDeRoles(["945562697993420813", "945560068986912808", "1114968517683450036"]),
    ).toBe("ADM++");

    // ADM++ (tier 9) + SUBDG (tier 10) + DG (tier 11) -> DG
    expect(
      obtenerRangoStaffDeRoles(["945560068986912808", "1298421134278262835", "945559013603545098"]),
    ).toBe("DG");

    // Con roles no-staff mezclados
    expect(
      obtenerRangoStaffDeRoles([
        "rol_comun_1",
        "945562075252555846", // SE (tier 3)
        "rol_comun_2",
        "1114968517683450036", // MOD+ (tier 5)
      ]),
    ).toBe("MOD+");
  });
});
