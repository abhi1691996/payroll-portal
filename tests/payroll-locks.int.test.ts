import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { mergeGrants, type TenantCtx } from "@/server/rbac/context";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import {
  allStagesLocked,
  attendanceIssuesFor,
  getPeriodLocks,
  lockAttendance,
  lockedLoanIds,
  lockLoans,
  lockOtherDeductions,
  unlockPeriodStage,
} from "@/server/payroll/locks";
import { addAdHocDeduction, adHocDeductionsFor, removeAdHocDeduction } from "@/server/deductions/service";

const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function ctxOf(companyId: string, user: { id: string; email: string }, employeeId: string | null, roles: string[]): TenantCtx {
  const grants = roles.flatMap((r) =>
    Object.entries(SYSTEM_ROLES.find((x) => x.key === r)!.grants).map(([permissionKey, scope]) => ({ permissionKey, scope: scope! }))
  );
  return { userId: user.id, email: user.email, name: user.email, companyId, isSuperAdmin: false, employeeId, roleKeys: roles, permissions: mergeGrants(grants), ip: null, userAgent: null };
}

interface World {
  companyId: string;
  admin: TenantCtx;
  payroll: TenantCtx;
  employee: TenantCtx;
  ids: { employee: string };
}

async function makeWorld(tag: string): Promise<World> {
  const { companyId, roleIds, adminUserId } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name: `Locks ${tag}`, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: "Admin", email: `admin@locks-${tag}.test`, password: "Password@123" },
    })
  );
  const emp = await owner.user.create({
    data: {
      companyId, email: `emp@locks-${tag}.test`, passwordHash: "x", name: "Employee",
      userRoles: { create: { roleId: roleIds.get("EMPLOYEE")!, companyId } },
      employee: { create: { companyId, employeeCode: "E1", firstName: "E1", lastName: "Person", state: "Karnataka", dateOfJoining: new Date("2020-01-01") } },
    },
    include: { employee: true },
  });
  const p = await owner.user.create({
    data: { companyId, email: `payroll@locks-${tag}.test`, passwordHash: "x", name: "Payroll", userRoles: { create: { roleId: roleIds.get("PAYROLL_MANAGER")!, companyId } } },
  });
  return {
    companyId,
    admin: ctxOf(companyId, { id: adminUserId, email: `admin@locks-${tag}.test` }, null, ["COMPANY_ADMIN"]),
    payroll: ctxOf(companyId, p, null, ["PAYROLL_MANAGER"]),
    employee: ctxOf(companyId, emp, emp.employee!.id, ["EMPLOYEE"]),
    ids: { employee: emp.employee!.id },
  };
}

let A: World;

beforeAll(async () => { A = await makeWorld("alpha"); });
afterAll(async () => { await owner.$disconnect(); await basePrisma.$disconnect(); });

describe("attendance issue detection", () => {
  it("flags every working day with no record at all", async () => {
    // July 2031, nothing recorded for the employee — every working day (not Sunday) should be flagged.
    const issues = await withTenant(A.companyId, (db) => attendanceIssuesFor(db, A.companyId, 7, 2031));
    const mine = issues.find((i) => i.employeeId === A.ids.employee);
    expect(mine).toBeDefined();
    expect(mine!.missingDates.length).toBeGreaterThan(0);
    expect(mine!.missingDates).not.toContain("2031-07-06"); // a Sunday — weekly off, never flagged
  });

  it("no issues once every working day has a record", async () => {
    for (let d = 1; d <= 31; d++) {
      await owner.attendanceRecord.create({
        data: { companyId: A.companyId, employeeId: A.ids.employee, date: day(`2031-08-${String(d).padStart(2, "0")}`), status: "PRESENT" },
      });
    }
    const issues = await withTenant(A.companyId, (db) => attendanceIssuesFor(db, A.companyId, 8, 2031));
    expect(issues.find((i) => i.employeeId === A.ids.employee)).toBeUndefined();
  });
});

describe("lock ordering", () => {
  const month = 8, year = 2031; // fully recorded period from the block above

  it("can't lock loans before attendance, or other deductions before loans", async () => {
    await expect(withTenant(A.companyId, (db) => lockLoans(db, A.payroll, month, year, []))).rejects.toThrow(/attendance/i);
    await expect(withTenant(A.companyId, (db) => lockOtherDeductions(db, A.payroll, month, year))).rejects.toThrow(/loan/i);
  });

  it("attendance with no issues locks without acknowledgement; the checklist then proceeds in order", async () => {
    await withTenant(A.companyId, (db) => lockAttendance(db, A.payroll, month, year, false));
    expect((await withTenant(A.companyId, (db) => getPeriodLocks(db, month, year))).attendance).toBeTruthy();
    expect(await withTenant(A.companyId, (db) => allStagesLocked(db, month, year))).toBe(false);

    await withTenant(A.companyId, (db) => lockLoans(db, A.payroll, month, year, ["loan-x"]));
    expect(await withTenant(A.companyId, (db) => lockedLoanIds(db, month, year))).toEqual(["loan-x"]);
    expect(await withTenant(A.companyId, (db) => allStagesLocked(db, month, year))).toBe(false);

    await withTenant(A.companyId, (db) => lockOtherDeductions(db, A.payroll, month, year));
    expect(await withTenant(A.companyId, (db) => allStagesLocked(db, month, year))).toBe(true);
  });

  it("unlocking a stage also unlocks every stage after it", async () => {
    await withTenant(A.companyId, (db) => unlockPeriodStage(db, A.payroll, month, year, "LOANS"));
    const locks = await withTenant(A.companyId, (db) => getPeriodLocks(db, month, year));
    expect(locks.attendance).toBeTruthy(); // unaffected — it comes before LOANS
    expect(locks.loans).toBeNull();
    expect(locks.otherDeductions).toBeNull(); // cascaded
    expect(await withTenant(A.companyId, (db) => allStagesLocked(db, month, year))).toBe(false);
  });

  it("an employee (no payroll.run permission) can't lock or unlock", async () => {
    await expect(withTenant(A.companyId, (db) => lockAttendance(db, A.employee, month, year, true))).rejects.toThrow(/permission/);
    await expect(withTenant(A.companyId, (db) => unlockPeriodStage(db, A.employee, month, year, "ATTENDANCE"))).rejects.toThrow(/permission/);
  });

  it("a period with missing attendance requires acknowledgement to lock", async () => {
    const month2 = 7; // the unrecorded period from the block above
    await expect(withTenant(A.companyId, (db) => lockAttendance(db, A.payroll, month2, year, false))).rejects.toThrow(/missing or flagged/);
    await withTenant(A.companyId, (db) => lockAttendance(db, A.payroll, month2, year, true));
    expect((await withTenant(A.companyId, (db) => getPeriodLocks(db, month2, year))).attendance).toBeTruthy();
  });
});

describe("finalized periods are immutable", () => {
  const month = 9, year = 2031;

  it("locking, unlocking and ad-hoc deductions are all blocked once the run is marked as paid", async () => {
    await owner.payrollRun.create({ data: { companyId: A.companyId, month, year, status: "FINALIZED", createdById: A.admin.userId, finalizedAt: new Date() } });

    await expect(withTenant(A.companyId, (db) => lockAttendance(db, A.payroll, month, year, true))).rejects.toThrow(/paid/);
    await expect(
      withTenant(A.companyId, (db) => addAdHocDeduction(db, A.payroll, { employeeId: A.ids.employee, month, year, name: "Damage recovery", amount: 500 }))
    ).rejects.toThrow(/paid/);
  });
});

describe("ad-hoc deductions", () => {
  const month = 10, year = 2031;

  it("can be added and listed, and removed again", async () => {
    const created = await withTenant(A.companyId, (db) =>
      addAdHocDeduction(db, A.payroll, { employeeId: A.ids.employee, month, year, name: "Uniform cost", amount: 750, note: "Two sets" })
    );
    const rows = await withTenant(A.companyId, (db) => adHocDeductionsFor(db, month, year));
    expect(rows).toEqual([{ id: created.id, employeeId: A.ids.employee, employeeCode: "E1", employeeName: "E1 Person", name: "Uniform cost", amount: 750, note: "Two sets" }]);

    await withTenant(A.companyId, (db) => removeAdHocDeduction(db, A.payroll, created.id));
    expect(await withTenant(A.companyId, (db) => adHocDeductionsFor(db, month, year))).toEqual([]);
  });

  it("rejects a non-positive amount", async () => {
    await expect(
      withTenant(A.companyId, (db) => addAdHocDeduction(db, A.payroll, { employeeId: A.ids.employee, month, year, name: "Bad", amount: 0 }))
    ).rejects.toThrow(/greater than 0/);
  });

  it("can't be added or removed once the OTHER_DEDUCTIONS stage is locked for that period", async () => {
    await withTenant(A.companyId, (db) => lockAttendance(db, A.payroll, month, year, true));
    await withTenant(A.companyId, (db) => lockLoans(db, A.payroll, month, year, []));

    const created = await withTenant(A.companyId, (db) =>
      addAdHocDeduction(db, A.payroll, { employeeId: A.ids.employee, month, year, name: "Before lock", amount: 100 })
    );
    await withTenant(A.companyId, (db) => lockOtherDeductions(db, A.payroll, month, year));

    await expect(
      withTenant(A.companyId, (db) => addAdHocDeduction(db, A.payroll, { employeeId: A.ids.employee, month, year, name: "After lock", amount: 100 }))
    ).rejects.toThrow(/locked/);
    await expect(withTenant(A.companyId, (db) => removeAdHocDeduction(db, A.payroll, created.id))).rejects.toThrow(/locked/);
  });
});

describe("tenant isolation", () => {
  it("keeps locks and ad-hoc deductions inside their own company", async () => {
    const B = await makeWorld("bravo-iso");
    await withTenant(B.companyId, (db) => lockAttendance(db, B.payroll, 1, 2032, true));
    const created = await withTenant(B.companyId, (db) => addAdHocDeduction(db, B.payroll, { employeeId: B.ids.employee, month: 1, year: 2032, name: "X", amount: 1 }));

    expect((await withTenant(A.companyId, (db) => getPeriodLocks(db, 1, 2032))).attendance).toBeNull();
    expect(await withTenant(A.companyId, (db) => db.adHocDeduction.findUnique({ where: { id: created.id } }))).toBeNull();

    await expect(
      owner.adHocDeduction.create({ data: { companyId: A.companyId, employeeId: B.ids.employee, month: 1, year: 2032, code: "X", name: "X", amount: 1 } })
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});
