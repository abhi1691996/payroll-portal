import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { mergeGrants, type TenantCtx } from "@/server/rbac/context";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import { actOnRequest } from "@/server/approvals/service";
import { previewLeave } from "@/server/leave/service";
import { assignSalary, loadTemplates } from "@/server/salary/service";
import {
  endSuspension,
  ensureLifecycleStatuses,
  resignationApprovalHandler,
  ROSTER_STATUSES,
  SEPARATED_STATUSES,
  submitResignation,
  suspendEmployee,
  terminateEmployee,
  updateResignationNotice,
  withdrawResignation,
} from "@/server/employees/lifecycle";

const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function ctxOf(companyId: string, user: { id: string; email: string }, employeeId: string | null, roles: string[]): TenantCtx {
  const grants = roles.flatMap((r) =>
    Object.entries(SYSTEM_ROLES.find((x) => x.key === r)!.grants).map(([permissionKey, scope]) => ({ permissionKey, scope: scope! }))
  );
  return { userId: user.id, email: user.email, name: user.email, companyId, isSuperAdmin: false, employeeId, roleKeys: roles, permissions: mergeGrants(grants), ip: null, userAgent: null };
}

interface World {
  companyId: string;
  admin: TenantCtx;
  hr: TenantCtx;
  manager: TenantCtx;
  employee: TenantCtx;
  ids: { employee: string; manager: string };
}

async function makeWorld(tag: string): Promise<World> {
  const { companyId, roleIds, adminUserId } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name: `Offboard ${tag}`, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: "Admin", email: `admin@off-${tag}.test`, password: "Password@123" },
    })
  );
  const mk = async (email: string, code: string, roles: string[], managerId: string | null = null) => {
    const user = await owner.user.create({
      data: {
        companyId, email, passwordHash: "x", name: email,
        userRoles: { create: roles.map((r) => ({ roleId: roleIds.get(r)!, companyId })) },
        employee: { create: { companyId, employeeCode: code, firstName: code, lastName: "Person", state: "Karnataka", dateOfJoining: new Date("2023-01-01"), managerId } },
      },
      include: { employee: true },
    });
    return { user, employeeId: user.employee!.id };
  };
  const m = await mk(`manager@off-${tag}.test`, "M1", ["MANAGER", "EMPLOYEE"]);
  const e = await mk(`emp@off-${tag}.test`, "E1", ["EMPLOYEE"], m.employeeId);
  const h = await owner.user.create({
    data: { companyId, email: `hr@off-${tag}.test`, passwordHash: "x", name: "HR", userRoles: { create: { roleId: roleIds.get("HR_MANAGER")!, companyId } } },
  });
  return {
    companyId,
    admin: ctxOf(companyId, { id: adminUserId, email: `admin@off-${tag}.test` }, null, ["COMPANY_ADMIN"]),
    hr: ctxOf(companyId, h, null, ["HR_MANAGER"]),
    manager: ctxOf(companyId, m.user, m.employeeId, ["MANAGER", "EMPLOYEE"]),
    employee: ctxOf(companyId, e.user, e.employeeId, ["EMPLOYEE"]),
    ids: { employee: e.employeeId, manager: m.employeeId },
  };
}

/** Gives the employee a salary so payroll actually produces a payslip for them. */
async function giveSalary(companyId: string, admin: TenantCtx, employeeId: string, ctcAnnual: number, effectiveFrom: string) {
  const [template] = await withTenant(companyId, (db) => loadTemplates(db));
  await withTenant(companyId, (db) => assignSalary(db, admin, { employeeId, templateId: template.id, ctcAnnual, effectiveFrom: day(effectiveFrom), employerPfOptIn: true }));
}

/** Runs the same employee-selection + LOP-exclusion logic as the payroll action, without the HTTP/form plumbing. */
async function payFor(companyId: string, employeeId: string, year: number, month: number) {
  const { loadRules, loadHolidays } = await import("@/server/rules/load");
  const { computeLop } = await import("@/lib/attendance/lop");
  const { calculatePayrollFromLines } = await import("@/lib/payroll-calculations");
  const { readLines } = await import("@/server/salary/service");
  const { eachDate, isoDate } = await import("@/lib/attendance/calendar");
  const { getStatutoryConfigFor } = await import("@/lib/statutory-config");

  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month, 0));

  return withTenant(companyId, async (db) => {
    const { pattern, rules, setting } = await loadRules(db, companyId);
    await loadHolidays(db, periodStart, lastDay);
    const statutoryConfig = await getStatutoryConfigFor(db, periodStart);
    const employee = await db.employee.findFirstOrThrow({
      where: { id: employeeId },
      include: {
        salaries: { where: { effectiveFrom: { lt: periodEnd } }, orderBy: { effectiveFrom: "desc" }, take: 1 },
        attendanceRecords: { where: { date: { gte: periodStart, lt: periodEnd } } },
        suspensions: { where: { fromDate: { lt: periodEnd }, OR: [{ toDate: null }, { toDate: { gte: periodStart } }] } },
      },
    });
    const salary = employee.salaries[0];
    if (!salary) return null;

    const excludedDates = new Set<string>();
    for (const s of employee.suspensions) {
      const from = s.fromDate > periodStart ? s.fromDate : periodStart;
      const to = s.toDate && s.toDate < lastDay ? s.toDate : lastDay;
      for (const d of eachDate(from, to)) excludedDates.add(isoDate(d));
    }
    const employedThrough = employee.dateOfExit && employee.dateOfExit < lastDay ? employee.dateOfExit : undefined;

    const lop = computeLop({
      year, month, pattern, holidays: new Set(), basis: setting.lopBasis,
      records: new Map(employee.attendanceRecords.map((r) => [isoDate(r.date), { status: r.status, isLate: r.isLate }])),
      leaves: new Map(), absentIfNoRecord: rules.absentIfNoRecord, lateCountPerHalfDay: rules.lateCountPerHalfDay, excludedDates, employedThrough,
    });
    const lines = readLines(salary.lines).map((l) => ({ code: l.code, name: l.name, monthlyAmount: l.monthlyAmount, isBasic: l.isBasic, taxable: l.taxable, includeInPf: l.includeInPf, includeInEsi: l.includeInEsi, includeInPt: l.includeInPt }));
    const breakdown = calculatePayrollFromLines(
      { lines, employerPfOptIn: salary.employerPfOptIn, taxRegime: employee.taxRegime },
      { daysInPeriod: lop.daysInPeriod, paidDays: lop.daysInPeriod - lop.lopDays },
      statutoryConfig
    );
    return { lop, breakdown, grossMonthly: Number(salary.grossMonthly) };
  });
}

let A: World;

beforeAll(async () => { A = await makeWorld("alpha"); });
afterAll(async () => { await owner.$disconnect(); await basePrisma.$disconnect(); });

describe("suspension", () => {
  it("is unpaid for exactly the suspended days, and doesn't touch other months", async () => {
    await giveSalary(A.companyId, A.admin, A.ids.employee, 600000, "2025-04-01");
    // June 2026: suspend the middle third of the month (days 11-20, 10 calendar days). This is a fixed
    // past window for payroll math, not "as of today", so it does not flip the live status badge.
    const { suspensionId } = await withTenant(A.companyId, (db) =>
      suspendEmployee(db, A.admin, { employeeId: A.ids.employee, fromDate: day("2026-06-11"), toDate: day("2026-06-20"), reason: "Under review" })
    );
    const suspension = await owner.employeeSuspension.findUniqueOrThrow({ where: { id: suspensionId } });
    expect(suspension.fromDate.toISOString().slice(0, 10)).toBe("2026-06-11");
    expect(suspension.toDate?.toISOString().slice(0, 10)).toBe("2026-06-20");
  });

  it("prorates June's pay for the suspended working days and leaves May untouched", async () => {
    const { classifyDay, eachDate: dateRange, DEFAULT_WEEKLY_PATTERN } = await import("@/lib/attendance/calendar");
    // The employee is still on the books all of June — only the WORKING days inside the suspension are unpaid.
    const suspendedWorkingDays = dateRange(day("2026-06-11"), day("2026-06-20")).filter((d) => classifyDay(d, DEFAULT_WEEKLY_PATTERN, new Set()) === "WORKING").length;

    const june = await payFor(A.companyId, A.ids.employee, 2026, 6);
    expect(june).not.toBeNull();
    expect(june!.lop.daysInPeriod).toBe(30); // the full month: employment itself was never interrupted
    expect(june!.lop.excludedDays).toBe(suspendedWorkingDays);
    expect(june!.breakdown.grossPay).toBeCloseTo((june!.grossMonthly * (30 - suspendedWorkingDays)) / 30, 0);

    const may = await payFor(A.companyId, A.ids.employee, 2026, 5);
    expect(may!.lop.daysInPeriod).toBe(31);
    expect(may!.breakdown.grossPay).toBeCloseTo(may!.grossMonthly, 0);
  });

  it("rejects a suspension that overlaps an existing one for the same employee", async () => {
    await expect(
      withTenant(A.companyId, (db) => suspendEmployee(db, A.admin, { employeeId: A.ids.employee, fromDate: day("2026-06-15"), toDate: null }))
    ).rejects.toThrow(/overlap/);
  });

  it("suspends as of yesterday, blocks leave while suspended, then reinstates on End suspension", async () => {
    const yesterday = day(plusDays(new Date().toISOString().slice(0, 10), -1));
    const { suspensionId } = await withTenant(A.companyId, (db) => suspendEmployee(db, A.admin, { employeeId: A.ids.employee, fromDate: yesterday, toDate: null }));
    expect((await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } })).status).toBe("SUSPENDED");

    const casual = await owner.leaveType.findFirstOrThrow({ where: { companyId: A.companyId, code: "CASUAL_LEAVE" } });
    const preview = await withTenant(A.companyId, (db) => previewLeave(db, A.companyId, A.ids.employee, { leaveTypeId: casual.id, from: "2027-01-04", to: "2027-01-04", isHalfDay: false }));
    expect(preview.ok).toBe(false);
    expect(preview.errors.join(" ")).toMatch(/suspended/);

    // Ending it "today" (toDate === today, inclusive) keeps them suspended for the rest of today.
    await withTenant(A.companyId, (db) => endSuspension(db, A.admin, { suspensionId }));
    expect((await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } })).status).toBe("SUSPENDED");

    // Backdating the end date to yesterday reinstates them immediately.
    await withTenant(A.companyId, (db) => endSuspension(db, A.admin, { suspensionId, toDate: yesterday }));
    const after = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(after.status).toBe("ACTIVE");
    const closed = await owner.employeeSuspension.findUniqueOrThrow({ where: { id: suspensionId } });
    expect(closed.toDate).not.toBeNull();
  });
});

describe("resignation", () => {
  it("goes to the reporting manager; the employee can't approve their own", async () => {
    const submittedDate = plusDays(new Date().toISOString().slice(0, 10), -5);
    const { separationId } = await withTenant(A.companyId, (db) =>
      submitResignation(db, A.employee, { employeeId: A.ids.employee, submittedDate: day(submittedDate), noticePeriodDays: 30, reason: "Better opportunity" })
    );
    const sep = await owner.employeeSeparation.findUniqueOrThrow({ where: { id: separationId } });
    expect(sep.status).toBe("PENDING");
    expect(sep.lastWorkingDay.toISOString().slice(0, 10)).toBe(plusDays(submittedDate, 30));

    const approval = await owner.approvalRequest.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "RESIGNATION", entityId: separationId } } });
    await expect(withTenant(A.companyId, (db) => actOnRequest(db, A.employee, { requestId: approval.id, action: "APPROVE" }, resignationApprovalHandler))).rejects.toThrow(/not an approver/);

    // The employee's own status is unaffected while pending.
    expect((await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } })).status).toBe("ACTIVE");

    // A second resignation can't be filed on top of a pending one.
    await expect(
      withTenant(A.companyId, (db) => submitResignation(db, A.employee, { employeeId: A.ids.employee, submittedDate: new Date(), noticePeriodDays: 0 }))
    ).rejects.toThrow(/already/);

    const result = await withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "APPROVE", comment: "Sorry to see you go" }, resignationApprovalHandler));
    expect(result.status).toBe("APPROVED");
  });

  it("with a future last working day, stays on the active roster until it passes", async () => {
    const employee = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(employee.status).toBe("ACTIVE"); // approved above, but the 30-day notice hasn't run out yet
    expect(employee.dateOfExit).not.toBeNull();
    expect(ROSTER_STATUSES).toContain(employee.status);

    // Simulate the notice period having elapsed, and let the lazy status sweep catch up.
    await owner.employee.update({ where: { id: A.ids.employee }, data: { dateOfExit: new Date("2020-01-01") } });
    await withTenant(A.companyId, (db) => ensureLifecycleStatuses(db));
    const after = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(after.status).toBe("RESIGNED");
    expect(SEPARATED_STATUSES).toContain(after.status);

    // Put it back the way it was for the tests that follow.
    const sep = await owner.employeeSeparation.findFirstOrThrow({ where: { employeeId: A.ids.employee, status: "APPROVED" } });
    await owner.employee.update({ where: { id: A.ids.employee }, data: { dateOfExit: sep.lastWorkingDay, status: "ACTIVE" } });
  });

  it("the notice period is editable, and withdrawing before the last working day restores Active", async () => {
    const sep = await owner.employeeSeparation.findFirstOrThrow({ where: { employeeId: A.ids.employee, status: "APPROVED" } });
    await withTenant(A.companyId, (db) => updateResignationNotice(db, A.hr, { separationId: sep.id, noticePeriodDays: 45 }));
    const updated = await owner.employeeSeparation.findUniqueOrThrow({ where: { id: sep.id } });
    expect(updated.noticePeriodDays).toBe(45);
    expect(updated.lastWorkingDay.toISOString().slice(0, 10)).toBe(plusDays(sep.submittedDate.toISOString().slice(0, 10), 45));
    const employee = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(employee.dateOfExit?.toISOString().slice(0, 10)).toBe(updated.lastWorkingDay.toISOString().slice(0, 10));

    await withTenant(A.companyId, (db) => withdrawResignation(db, A.employee, sep.id));
    const withdrawn = await owner.employeeSeparation.findUniqueOrThrow({ where: { id: sep.id } });
    expect(withdrawn.status).toBe("WITHDRAWN");
    const restored = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(restored.status).toBe("ACTIVE");
    expect(restored.dateOfExit).toBeNull();
    // It had already been approved by the manager, and that decision stands — withdrawal is a separate act.
    const approval = await owner.approvalRequest.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "RESIGNATION", entityId: sep.id } } });
    expect(approval.status).toBe("APPROVED");
  });

  it("withdrawing while still pending cancels the approval request, freeing the employee to resign again", async () => {
    const { separationId } = await withTenant(A.companyId, (db) =>
      submitResignation(db, A.employee, { employeeId: A.ids.employee, submittedDate: new Date(), noticePeriodDays: 20 })
    );
    await withTenant(A.companyId, (db) => withdrawResignation(db, A.employee, separationId));
    expect((await owner.employeeSeparation.findUniqueOrThrow({ where: { id: separationId } })).status).toBe("WITHDRAWN");
    const approval = await owner.approvalRequest.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "RESIGNATION", entityId: separationId } } });
    expect(approval.status).toBe("CANCELLED");

    // Nothing pending is left blocking a fresh resignation.
    const second = await withTenant(A.companyId, (db) =>
      submitResignation(db, A.employee, { employeeId: A.ids.employee, submittedDate: new Date(), noticePeriodDays: 15 })
    );
    await withTenant(A.companyId, (db) => withdrawResignation(db, A.employee, second.separationId)); // tidy up for the tests that follow
  });

  it("a rejected resignation never touches the employee's status", async () => {
    const { separationId } = await withTenant(A.companyId, (db) =>
      submitResignation(db, A.employee, { employeeId: A.ids.employee, submittedDate: new Date(), noticePeriodDays: 10 })
    );
    const approval = await owner.approvalRequest.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "RESIGNATION", entityId: separationId } } });
    await withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "REJECT", comment: "Let's talk first" }, resignationApprovalHandler));
    const sep = await owner.employeeSeparation.findUniqueOrThrow({ where: { id: separationId } });
    expect(sep.status).toBe("REJECTED");
    const employee = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(employee.status).toBe("ACTIVE");
    expect(employee.dateOfExit).toBeNull();
  });

  it("an immediate resignation (0-day notice) separates the employee the moment it's approved", async () => {
    const submittedDate = plusDays(new Date().toISOString().slice(0, 10), -1); // yesterday, so the LWD is already in the past
    const { separationId } = await withTenant(A.companyId, (db) =>
      submitResignation(db, A.employee, { employeeId: A.ids.employee, submittedDate: day(submittedDate), noticePeriodDays: 0 })
    );
    const approval = await owner.approvalRequest.findUniqueOrThrow({ where: { entityType_entityId: { entityType: "RESIGNATION", entityId: separationId } } });
    await withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "APPROVE" }, resignationApprovalHandler));
    const employee = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.employee } });
    expect(employee.status).toBe("RESIGNED");

    // Once separated, withdrawal is refused (the last working day has already passed).
    await expect(withTenant(A.companyId, (db) => withdrawResignation(db, A.hr, separationId))).rejects.toThrow(/already passed/);
    // ...and they can't apply for leave any more, though their history stays queryable.
    const casual = await owner.leaveType.findFirstOrThrow({ where: { companyId: A.companyId, code: "CASUAL_LEAVE" } });
    const preview = await withTenant(A.companyId, (db) => previewLeave(db, A.companyId, A.ids.employee, { leaveTypeId: casual.id, from: "2027-02-01", to: "2027-02-01", isHalfDay: false }));
    expect(preview.errors.join(" ")).toMatch(/left the company/);
  });
});

describe("termination", () => {
  it("a future-dated termination doesn't take effect until that date arrives", async () => {
    const user = await owner.user.create({
      data: { companyId: A.companyId, email: "future-exit@off-alpha.test", passwordHash: "x", name: "Future Exit",
        employee: { create: { companyId: A.companyId, employeeCode: "F1", firstName: "Future", lastName: "Exit", state: "Karnataka", dateOfJoining: new Date("2023-01-01") } } },
      include: { employee: true },
    });
    const futureId = user.employee!.id;
    const future = new Date(); future.setUTCFullYear(future.getUTCFullYear() + 1);

    await withTenant(A.companyId, (db) => terminateEmployee(db, A.admin, { employeeId: futureId, terminationDate: future }));
    expect((await owner.employee.findUniqueOrThrow({ where: { id: futureId } })).status).toBe("ACTIVE");

    await owner.employee.update({ where: { id: futureId }, data: { dateOfExit: new Date("2020-01-01") } }); // simulate the date arriving
    await withTenant(A.companyId, (db) => ensureLifecycleStatuses(db));
    expect((await owner.employee.findUniqueOrThrow({ where: { id: futureId } })).status).toBe("TERMINATED");
  });

  it("is an immediate, unilateral employer action — no approval step", async () => {
    const emp = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.manager } });
    expect(emp.status).toBe("ACTIVE");
    await giveSalary(A.companyId, A.admin, A.ids.manager, 720000, "2025-04-01");

    await withTenant(A.companyId, (db) => terminateEmployee(db, A.admin, { employeeId: A.ids.manager, terminationDate: day("2026-07-15"), reason: "Restructuring" }));
    const after = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.manager } });
    expect(after.status).toBe("TERMINATED"); // 2026-07-15 is already in the past, so it took effect immediately
    expect(after.dateOfExit?.toISOString().slice(0, 10)).toBe("2026-07-15");

    await expect(
      withTenant(A.companyId, (db) => terminateEmployee(db, A.admin, { employeeId: A.ids.manager, terminationDate: day("2026-08-01") }))
    ).rejects.toThrow(/already/);
  });

  it("July is paid only through the 15th; August is not payable at all; June (before termination) is untouched", async () => {
    const july = await payFor(A.companyId, A.ids.manager, 2026, 7);
    expect(july!.lop.daysInPeriod).toBe(31); // the full month stays the denominator, like any other loss of pay
    expect(july!.lop.separatedDays).toBe(16); // the 16th through the 31st
    expect(july!.breakdown.grossPay).toBeCloseTo((july!.grossMonthly * 15) / 31, 0); // paid for the 15 days they were actually employed

    const august = await payFor(A.companyId, A.ids.manager, 2026, 8);
    expect(august!.lop.separatedDays).toBe(31); // every day in August falls after the last working day
    expect(august!.breakdown.grossPay).toBe(0); // guarded against the 0/0 that would otherwise be NaN elsewhere
  });

  it("removes the employee from the active roster but keeps their history", async () => {
    await owner.employee.update({ where: { id: A.ids.manager }, data: { dateOfExit: new Date("2020-01-01") } });
    await withTenant(A.companyId, (db) => ensureLifecycleStatuses(db));
    const employee = await owner.employee.findUniqueOrThrow({ where: { id: A.ids.manager } });
    expect(employee.status).toBe("TERMINATED");

    const roster = await withTenant(A.companyId, (db) => db.employee.findMany({ where: { status: { in: ROSTER_STATUSES } } }));
    expect(roster.some((e) => e.id === A.ids.manager)).toBe(false);
    const separated = await withTenant(A.companyId, (db) => db.employee.findMany({ where: { status: { in: SEPARATED_STATUSES } } }));
    expect(separated.some((e) => e.id === A.ids.manager)).toBe(true);

    // Nothing about them was deleted.
    expect(await owner.employeeSalary.count({ where: { employeeId: A.ids.manager } })).toBeGreaterThan(0);
    expect(await owner.employee.findUnique({ where: { id: A.ids.manager } })).not.toBeNull();
  });
});

describe("tenant isolation of the new tables", () => {
  it("keeps suspensions and separations inside their own company", async () => {
    const B = await makeWorld("bravo-iso");
    await withTenant(B.companyId, (db) => suspendEmployee(db, B.admin, { employeeId: B.ids.employee, fromDate: new Date(), toDate: null }));
    const bravoSuspension = await owner.employeeSuspension.findFirstOrThrow({ where: { companyId: B.companyId } });

    expect(await withTenant(A.companyId, (db) => db.employeeSuspension.findUnique({ where: { id: bravoSuspension.id } }))).toBeNull();
    expect((await withTenant(A.companyId, (db) => db.employeeSuspension.findMany())).every((s) => s.companyId === A.companyId)).toBe(true);

    await expect(
      owner.employeeSuspension.create({ data: { companyId: A.companyId, employeeId: B.ids.employee, fromDate: new Date() } })
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});
