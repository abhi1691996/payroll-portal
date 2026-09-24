import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { mergeGrants, type TenantCtx } from "@/server/rbac/context";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import { loadTemplates, assignSalary } from "@/server/salary/service";
import { computeDashboardMetrics, metricDetails } from "@/server/dashboard/management";
import { daysInMonth } from "@/lib/dates";

const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

function ctxOf(companyId: string, user: { id: string; email: string }, employeeId: string | null, roles: string[]): TenantCtx {
  const grants = roles.flatMap((r) =>
    Object.entries(SYSTEM_ROLES.find((x) => x.key === r)!.grants).map(([permissionKey, scope]) => ({ permissionKey, scope: scope! }))
  );
  return { userId: user.id, email: user.email, name: user.email, companyId, isSuperAdmin: false, employeeId, roleKeys: roles, permissions: mergeGrants(grants), ip: null, userAgent: null };
}

async function makeCompany(tag: string) {
  const { companyId, roleIds, adminUserId } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name: `Dash ${tag}`, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: "Admin", email: `admin@dash-${tag}.test`, password: "Password@123" },
    })
  );
  const admin = ctxOf(companyId, { id: adminUserId, email: `admin@dash-${tag}.test` }, null, ["COMPANY_ADMIN"]);

  const mkEmployee = async (code: string, dept: string, dateOfJoining: Date, dateOfBirth?: Date) =>
    owner.employee.create({
      data: { companyId, employeeCode: code, firstName: code, lastName: "Person", department: dept, state: "Karnataka", dateOfJoining, dateOfBirth },
    });

  return { companyId, admin, roleIds, mkEmployee };
}

const TEST_DATE = day("2031-05-15"); // a Thursday: a normal working day, no ambiguity with weekly-off logic

describe("computeDashboardMetrics", () => {
  it("counts workforce, attendance breakdown, flags, birthdays, anniversaries, department split, and workforce-change events all for one day", async () => {
    const { companyId, admin, mkEmployee } = await makeCompany("alpha");

    const e1 = await mkEmployee("E1", "Engineering", day("2029-01-01"), day("1995-05-15")); // birthday today
    const e2 = await mkEmployee("E2", "Engineering", day("2028-05-15")); // work anniversary today (joined 3 years earlier)
    const e3 = await mkEmployee("E3", "Sales", day("2029-01-01"));
    const e4 = await mkEmployee("E4", "Sales", day("2029-01-01"));
    const e5 = await mkEmployee("E5", "Sales", day("2029-01-01"));
    const e6 = await mkEmployee("E6", "Engineering", day("2029-01-01"));

    await owner.attendanceRecord.create({
      data: { companyId, employeeId: e1.id, date: TEST_DATE, status: "PRESENT", isLate: true, lateMinutes: 15, earlyLeaveMinutes: 20, flags: "MISSING_PUNCH" },
    });
    await owner.attendanceRecord.create({ data: { companyId, employeeId: e2.id, date: TEST_DATE, status: "ABSENT" } });
    await owner.attendanceRecord.create({ data: { companyId, employeeId: e3.id, date: TEST_DATE, status: "WFH" } });
    await owner.attendanceRecord.create({ data: { companyId, employeeId: e4.id, date: TEST_DATE, status: "HALF_DAY" } });
    // e5 has no attendance record at all this day.

    await owner.employeeSuspension.create({ data: { companyId, employeeId: e4.id, fromDate: day("2031-05-01"), toDate: day("2031-05-31") } });
    await owner.employeeSeparation.create({
      data: { companyId, employeeId: e5.id, type: "RESIGNATION", status: "PENDING", submittedDate: TEST_DATE, noticePeriodDays: 30, lastWorkingDay: day("2031-06-14") },
    });
    await owner.employeeSeparation.create({
      data: { companyId, employeeId: e6.id, type: "TERMINATION", status: "APPROVED", submittedDate: TEST_DATE, lastWorkingDay: TEST_DATE, decidedAt: new Date(), decidedByUserId: admin.userId },
    });

    // Salary only for e1 (to check the daily-cost estimate precisely without depending on the others).
    const [template] = await withTenant(companyId, (db) => loadTemplates(db));
    const { grossMonthly } = await withTenant(companyId, (db) =>
      assignSalary(db, admin, { employeeId: e1.id, templateId: template.id, ctcAnnual: 600000, effectiveFrom: day("2029-01-01"), employerPfOptIn: true })
    );

    const metrics = await withTenant(companyId, (db) => computeDashboardMetrics(db, companyId, TEST_DATE));

    expect(metrics.totalWorkforce).toBe(6);
    expect(metrics.present).toBe(1);
    expect(metrics.absent).toBe(1);
    expect(metrics.wfh).toBe(1);
    expect(metrics.halfDay).toBe(1);
    expect(metrics.missedPunches).toBe(1);
    expect(metrics.lateComings).toBe(1);
    expect(metrics.earlyLeaves).toBe(1);
    expect(metrics.birthdays).toBe(1);
    expect(metrics.workAnniversaries).toBe(1);
    expect(metrics.weekOff).toBe(0); // a normal Thursday
    expect(metrics.suspensions).toBe(1);
    expect(metrics.resignationsPending).toBe(1);
    expect(metrics.terminationsToday).toBe(1);
    expect(metrics.departmentCount).toBe(2);
    const eng = metrics.departmentAttendance.find((d) => d.department === "Engineering")!;
    expect(eng.total).toBe(3); // e1, e2, e6
    expect(eng.present).toBe(1); // e1

    // e1 present all day: full daily rate = grossMonthly / days-in-May-2031.
    const expectedCost = Math.round((grossMonthly / daysInMonth(2031, 5)) * 100) / 100;
    expect(metrics.dailyPayrollCost).toBe(expectedCost);

    // Drill-downs return the right employees.
    const present = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "present"));
    expect(present.map((r) => r.employeeCode)).toEqual(["E1"]);
    const late = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "lateComings"));
    expect(late[0].extra).toMatch(/15 min/);
    const birthdays = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "birthdays"));
    expect(birthdays.map((r) => r.employeeCode)).toEqual(["E1"]);
    const anniversaries = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "workAnniversaries"));
    expect(anniversaries.map((r) => r.employeeCode)).toEqual(["E2"]);
    const suspended = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "suspensions"));
    expect(suspended.map((r) => r.employeeCode)).toEqual(["E4"]);
    const pending = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "resignationsPending"));
    expect(pending.map((r) => r.employeeCode)).toEqual(["E5"]);
    const terminated = await withTenant(companyId, (db) => metricDetails(db, companyId, TEST_DATE, "terminationsToday"));
    expect(terminated.map((r) => r.employeeCode)).toEqual(["E6"]);
  });

  it("treats a weekly off day as everyone's day off and pays them for it, with no present/absent breakdown", async () => {
    const { companyId, mkEmployee } = await makeCompany("weekoff");
    await mkEmployee("W1", "Ops", day("2029-01-01"));
    await mkEmployee("W2", "Ops", day("2029-01-01"));

    const sunday = day("2031-05-18"); // default weekly pattern: Sunday off
    const metrics = await withTenant(companyId, (db) => computeDashboardMetrics(db, companyId, sunday));
    expect(metrics.weekOff).toBe(2);
    expect(metrics.present).toBe(0);
    expect(metrics.absent).toBe(0);
  });

  it("an employee with no attendance record yet is neither present nor absent, but counted in the workforce", async () => {
    const { companyId, mkEmployee } = await makeCompany("norecord");
    await mkEmployee("N1", "Ops", day("2029-01-01"));

    const metrics = await withTenant(companyId, (db) => computeDashboardMetrics(db, companyId, TEST_DATE));
    expect(metrics.totalWorkforce).toBe(1);
    expect(metrics.present).toBe(0);
    expect(metrics.absent).toBe(0);
  });
});

afterAll(async () => {
  await owner.$disconnect();
  await basePrisma.$disconnect();
});
