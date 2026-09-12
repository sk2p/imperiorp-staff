import { describe, expect, it } from "vitest";

import {
  addDays,
  buildPeriodCode,
  formatPeriodLabel,
  isCalendarDate,
  isDateWithinPeriod,
  periodLengthInDays,
  periodsOverlap,
  suggestNextPeriod,
  validatePeriodRange,
} from "@/domain/periods";
import {
  canManageRole,
  effectivePermissions,
  hasPermission,
  PERMISSIONS,
} from "@/domain/permissions";
import { categoryForRank, compareRankChange, isStaffRank } from "@/domain/ranks";
import { isRotationDay } from "@/server/rotation";

describe("períodos de liquidación", () => {
  it("acepta el rango de ejemplo de Imperio RP", () => {
    const result = validatePeriodRange("2026-09-01", "2026-09-08");
    expect(result.valid).toBe(true);
    expect(periodLengthInDays("2026-09-01", "2026-09-08")).toBe(8);
    expect(formatPeriodLabel("2026-09-01", "2026-09-08")).toBe("01/09/2026 → 08/09/2026");
  });

  it("rechaza un rango invertido", () => {
    expect(validatePeriodRange("2026-09-08", "2026-09-01").valid).toBe(false);
  });

  it("rechaza fechas inexistentes", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("01/09/2026")).toBe(false);
    expect(isCalendarDate("2026-02-29")).toBe(false); // 2026 no es bisiesto
    expect(isCalendarDate("2024-02-29")).toBe(true); // 2024 sí lo es
  });

  it("detecta cualquier solapamiento entre períodos", () => {
    const base = { startDate: "2026-09-01", endDate: "2026-09-08" };

    expect(periodsOverlap(base, { startDate: "2026-09-05", endDate: "2026-09-12" })).toBe(true);
    // Comparten un único día: igual se solapan.
    expect(periodsOverlap(base, { startDate: "2026-09-08", endDate: "2026-09-15" })).toBe(true);
    // Empieza justo al día siguiente: no se solapan.
    expect(periodsOverlap(base, { startDate: "2026-09-09", endDate: "2026-09-16" })).toBe(false);
    expect(periodsOverlap(base, { startDate: "2026-08-20", endDate: "2026-08-31" })).toBe(false);
  });

  it("sugiere el período siguiente conservando la duración", () => {
    const next = suggestNextPeriod({ startDate: "2026-09-01", endDate: "2026-09-08" });
    expect(next.startDate).toBe("2026-09-09");
    expect(next.endDate).toBe("2026-09-16");
    expect(periodLengthInDays(next.startDate, next.endDate)).toBe(8);
  });

  it("no se corre de día al cruzar meses o años", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("sabe si una fecha pertenece al período", () => {
    expect(isDateWithinPeriod("2026-09-01", "2026-09-01", "2026-09-08")).toBe(true);
    expect(isDateWithinPeriod("2026-09-08", "2026-09-01", "2026-09-08")).toBe(true);
    expect(isDateWithinPeriod("2026-08-31", "2026-09-01", "2026-09-08")).toBe(false);
    expect(isDateWithinPeriod("2026-09-09", "2026-09-01", "2026-09-08")).toBe(false);
  });

  it("genera un código único y estable por rango", () => {
    expect(buildPeriodCode("2026-09-01", "2026-09-08")).toBe("2026-09-01_2026-09-08");
  });
});

describe("rangos del staff", () => {
  it("deriva la categoría del rango, sin confiar en el cliente", () => {
    expect(categoryForRank("SDP")).toBe("SOPORTE");
    expect(categoryForRank("MOD++")).toBe("MODERACION");
    expect(categoryForRank("ADM")).toBe("ADMINISTRACION");
  });

  it("valida los rangos oficiales", () => {
    expect(isStaffRank("MOD+")).toBe(true);
    expect(isStaffRank("SUPERADMIN")).toBe(false);
    expect(isStaffRank("")).toBe(false);
  });

  it("clasifica los cambios de rango", () => {
    expect(compareRankChange("MOD", "ADM")).toBe("ascenso");
    expect(compareRankChange("ADM", "MOD")).toBe("descenso");
    expect(compareRankChange("MOD", "MOD")).toBe("lateral");
  });
});

describe("permisos", () => {
  it("le da todo al OWNER", () => {
    const owner = { role: "OWNER" };
    expect(hasPermission(owner, PERMISSIONS.WEEKS_REOPEN)).toBe(true);
    expect(hasPermission(owner, PERMISSIONS.PAYMENTS_VOID)).toBe(true);
    expect(hasPermission(owner, PERMISSIONS.SETTINGS_MANAGE)).toBe(true);
  });

  it("limita a HIGH_STAFF en las operaciones irreversibles", () => {
    const highStaff = { role: "HIGH_STAFF" };
    expect(hasPermission(highStaff, PERMISSIONS.WEEKS_CLOSE)).toBe(true);
    expect(hasPermission(highStaff, PERMISSIONS.WEEKS_REOPEN)).toBe(false);
    expect(hasPermission(highStaff, PERMISSIONS.PAYMENTS_VOID)).toBe(false);
    expect(hasPermission(highStaff, PERMISSIONS.SETTINGS_MANAGE)).toBe(false);
  });

  it("deja al AUDITOR en sólo lectura", () => {
    const auditor = { role: "AUDITOR" };
    expect(hasPermission(auditor, PERMISSIONS.AUDIT_VIEW)).toBe(true);
    expect(hasPermission(auditor, PERMISSIONS.HOURS_VIEW)).toBe(true);
    expect(hasPermission(auditor, PERMISSIONS.HOURS_CREATE)).toBe(false);
    expect(hasPermission(auditor, PERMISSIONS.PAYMENTS_CREATE)).toBe(false);
  });

  it("niega el acceso sin usuario", () => {
    expect(hasPermission(null, PERMISSIONS.STAFF_VIEW)).toBe(false);
    expect(hasPermission(undefined, PERMISSIONS.STAFF_VIEW)).toBe(false);
    expect(effectivePermissions(null).size).toBe(0);
  });

  it("respeta los permisos concedidos individualmente", () => {
    const user = { role: "MANAGER", grantedPermissions: [PERMISSIONS.PAYMENTS_CREATE] };
    expect(hasPermission(user, PERMISSIONS.PAYMENTS_CREATE)).toBe(true);
  });

  it("da prioridad a los permisos revocados sobre los del rol", () => {
    const user = { role: "HIGH_STAFF", revokedPermissions: [PERMISSIONS.HOURS_DELETE] };
    expect(hasPermission(user, PERMISSIONS.HOURS_DELETE)).toBe(false);
    expect(hasPermission(user, PERMISSIONS.HOURS_EDIT)).toBe(true);
  });

  it("ignora permisos inventados que lleguen del cliente", () => {
    const user = { role: "AUDITOR", grantedPermissions: ["sistema.hackear", "*"] };
    const effective = effectivePermissions(user);
    expect(effective.has("sistema.hackear" as never)).toBe(false);
    expect(hasPermission(user, PERMISSIONS.PAYMENTS_CREATE)).toBe(false);
  });

  it("impide la escalada de privilegios entre usuarios", () => {
    // Nadie administra a alguien de jerarquía igual o mayor.
    expect(canManageRole("HIGH_STAFF", "OWNER")).toBe(false);
    expect(canManageRole("HIGH_STAFF", "HIGH_STAFF")).toBe(false);
    expect(canManageRole("HIGH_STAFF", "MANAGER")).toBe(true);
    expect(canManageRole("OWNER", "HIGH_STAFF")).toBe(true);
    expect(canManageRole("MANAGER", "AUDITOR")).toBe(true);
    expect(canManageRole("AUDITOR", "MANAGER")).toBe(false);
    expect(canManageRole("rol-inventado", "MANAGER")).toBe(false);
  });
});

describe("rotación automática de los sábados", () => {
  it("reconoce el sábado y sólo el sábado", () => {
    // 2026-09-12 es sábado; la semana entera alrededor sirve de control.
    expect(isRotationDay("2026-09-12")).toBe(true);
    expect(isRotationDay("2026-09-19")).toBe(true);
    for (const day of [
      "2026-09-06",
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]) {
      expect(isRotationDay(day)).toBe(false);
    }
  });

  it("el período que abre un sábado termina el viernes siguiente", () => {
    // La rotación abre siete días desde el sábado: sábado a viernes.
    const fin = addDays("2026-09-12", 6);
    expect(fin).toBe("2026-09-18");
    expect(isRotationDay(fin)).toBe(false);
    expect(periodLengthInDays("2026-09-12", fin)).toBe(7);
  });

  it("el día siguiente a un período vencido arranca donde terminó el anterior", () => {
    // Si el programador falla el sábado y corre el lunes, el período nuevo no
    // empieza el lunes: empieza el día siguiente al que cerró, sin huecos.
    expect(addDays("2026-09-18", 1)).toBe("2026-09-19");
  });
});
