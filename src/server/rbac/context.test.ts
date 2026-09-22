import { describe, expect, it } from "vitest";
import { can, employeeScopeWhere, mergeGrants, scopeOf } from "./context";
import { SYSTEM_ROLES } from "./roles";
import { PERMISSIONS, PERMISSION_KEYS } from "./permissions";

const ctxWith = (grants: Record<string, "OWN" | "TEAM" | "COMPANY">, employeeId: string | null = "emp1") => ({
  permissions: mergeGrants(Object.entries(grants).map(([permissionKey, scope]) => ({ permissionKey, scope }))),
  employeeId,
});

describe("mergeGrants", () => {
  it("keeps the widest scope when several roles grant the same permission", () => {
    const merged = mergeGrants([
      { permissionKey: "leave.read", scope: "OWN" },
      { permissionKey: "leave.read", scope: "TEAM" },
      { permissionKey: "leave.read", scope: "OWN" },
    ]);
    expect(merged.get("leave.read")).toBe("TEAM");
  });
});

describe("can", () => {
  const ctx = ctxWith({ "attendance.read": "TEAM" });
  it("compares scope rank", () => {
    expect(can(ctx, "attendance.read", "OWN")).toBe(true);
    expect(can(ctx, "attendance.read", "TEAM")).toBe(true);
    expect(can(ctx, "attendance.read", "COMPANY")).toBe(false);
  });
  it("is false for a permission that was never granted", () => {
    expect(can(ctx, "payroll.run")).toBe(false);
    expect(scopeOf(ctx, "payroll.run")).toBeNull();
  });
});

describe("employeeScopeWhere", () => {
  it("COMPANY: no extra restriction", () => {
    expect(employeeScopeWhere(ctxWith({ "employee.read": "COMPANY" }), "employee.read")).toEqual({});
  });
  it("TEAM: only direct reports", () => {
    expect(employeeScopeWhere(ctxWith({ "employee.read": "TEAM" }), "employee.read")).toEqual({ managerId: "emp1" });
  });
  it("OWN: only themselves", () => {
    expect(employeeScopeWhere(ctxWith({ "employee.read": "OWN" }), "employee.read")).toEqual({ id: "emp1" });
  });
  it("matches nothing without a grant, or without a linked employee record", () => {
    expect(employeeScopeWhere(ctxWith({}), "employee.read")).toEqual({ id: "__none__" });
    expect(employeeScopeWhere(ctxWith({ "employee.read": "OWN" }, null), "employee.read")).toEqual({ id: "__none__" });
  });
});

describe("system role templates", () => {
  it("only reference permissions that exist in the catalogue", () => {
    for (const role of SYSTEM_ROLES) {
      for (const key of Object.keys(role.grants)) expect(key in PERMISSIONS, `${role.key} -> ${key}`).toBe(true);
    }
  });

  it("COMPANY_ADMIN holds every permission at company scope", () => {
    const admin = SYSTEM_ROLES.find((r) => r.key === "COMPANY_ADMIN")!;
    expect(Object.keys(admin.grants).sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(Object.values(admin.grants).every((s) => s === "COMPANY")).toBe(true);
  });

  it("MANAGER never gets salary or payroll access, and only team-level people access", () => {
    const manager = SYSTEM_ROLES.find((r) => r.key === "MANAGER")!;
    const keys = Object.keys(manager.grants);
    expect(keys.some((k) => k.startsWith("payroll.") || k.includes("salary") || k === "payslip.read")).toBe(false);
    expect(Object.values(manager.grants).every((s) => s === "TEAM")).toBe(true);
  });

  it("HR cannot see salary or run payroll; payroll manager can", () => {
    const hr = SYSTEM_ROLES.find((r) => r.key === "HR_MANAGER")!.grants;
    const payroll = SYSTEM_ROLES.find((r) => r.key === "PAYROLL_MANAGER")!.grants;
    expect(hr["employee.salary.read"]).toBeUndefined();
    expect(hr["payroll.run"]).toBeUndefined();
    expect(payroll["employee.salary.read"]).toBe("COMPANY");
    expect(payroll["payroll.run"]).toBe("COMPANY");
  });

  it("EMPLOYEE is limited to their own data", () => {
    const emp = SYSTEM_ROLES.find((r) => r.key === "EMPLOYEE")!.grants;
    expect(Object.values(emp).every((s) => s === "OWN")).toBe(true);
    expect(emp["leave.approve"]).toBeUndefined();
  });
});
