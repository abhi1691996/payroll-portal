import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { ensureCompanyDefaults } from "@/server/companies/defaults";
import { mergeGrants, type TenantCtx } from "@/server/rbac/context";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import { actOnRequest, actionableRequests } from "@/server/approvals/service";
import { cancelLeave, ensureAccruals, leaveApprovalHandler, leaveBalances, previewLeave, setLeaveBalance, submitLeave } from "@/server/leave/service";
import { assignSalary, loadTemplates } from "@/server/salary/service";
import { saveAttendanceDays, type DayEntry } from "@/server/attendance/service";
import { parseTimeToMinutes } from "@/lib/time";

const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const t = (s: string) => parseTimeToMinutes(s)!;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Next Monday at least a week away, as ISO. Keeps the tests valid whatever day they run. */
function upcomingMonday(weeksAhead = 1): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7 * (weeksAhead - 1) + 7);
  return d.toISOString().slice(0, 10);
}
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface World {
  companyId: string;
  admin: TenantCtx;
  hr: TenantCtx;
  manager: TenantCtx;
  employee: TenantCtx;
  loner: TenantCtx; // an employee with no reporting manager
  ids: { employee: string; manager: string; loner: string };
}

function ctxOf(companyId: string, user: { id: string; email: string }, employeeId: string | null, roles: string[]): TenantCtx {
  const grants = roles.flatMap((r) =>
    Object.entries(SYSTEM_ROLES.find((x) => x.key === r)!.grants).map(([permissionKey, scope]) => ({ permissionKey, scope: scope! }))
  );
  return { userId: user.id, email: user.email, name: user.email, companyId, isSuperAdmin: false, employeeId, roleKeys: roles, permissions: mergeGrants(grants), ip: null, userAgent: null };
}

async function makeWorld(tag: string): Promise<World> {
  const { companyId, roleIds, adminUserId } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name: `Engine ${tag}`, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: "Admin", email: `admin@eng-${tag}.test`, password: "Password@123" },
    })
  );
  const mk = async (email: string, code: string, roles: string[], managerId: string | null = null, withEmployee = true) => {
    const user = await owner.user.create({
      data: {
        companyId, email, passwordHash: "x", name: email,
        userRoles: { create: roles.map((r) => ({ roleId: roleIds.get(r)!, companyId })) },
        ...(withEmployee
          ? { employee: { create: { companyId, employeeCode: code, firstName: code, lastName: "Person", state: "Karnataka", dateOfJoining: new Date("2023-01-01"), managerId } } }
          : {}),
      },
      include: { employee: true },
    });
    return { user, employeeId: user.employee?.id ?? null };
  };
  const m = await mk(`manager@eng-${tag}.test`, "M1", ["MANAGER", "EMPLOYEE"]);
  const e = await mk(`emp@eng-${tag}.test`, "E1", ["EMPLOYEE"], m.employeeId);
  const l = await mk(`loner@eng-${tag}.test`, "L1", ["EMPLOYEE"]);
  const h = await mk(`hr@eng-${tag}.test`, "H1", ["HR_MANAGER"], null, false);
  return {
    companyId,
    admin: ctxOf(companyId, { id: adminUserId, email: `admin@eng-${tag}.test` }, null, ["COMPANY_ADMIN"]),
    hr: ctxOf(companyId, h.user, null, ["HR_MANAGER"]),
    manager: ctxOf(companyId, m.user, m.employeeId, ["MANAGER", "EMPLOYEE"]),
    employee: ctxOf(companyId, e.user, e.employeeId, ["EMPLOYEE"]),
    loner: ctxOf(companyId, l.user, l.employeeId, ["EMPLOYEE"]),
    ids: { employee: e.employeeId!, manager: m.employeeId!, loner: l.employeeId! },
  };
}

let A: World;
let B: World;

beforeAll(async () => {
  A = await makeWorld("alpha");
  B = await makeWorld("bravo");
});
afterAll(async () => {
  await owner.$disconnect();
  await basePrisma.$disconnect();
});

const typeId = async (companyId: string, code: string) => (await owner.leaveType.findFirstOrThrow({ where: { companyId, code } })).id;

/* ------------------------------------- defaults ------------------------------------- */

describe("company defaults", () => {
  it("a new company starts with editable salary, shift, attendance, leave and approval rules", async () => {
    const n = async (m: "salaryComponent" | "salaryTemplate" | "shift" | "attendanceRule" | "companySetting" | "leavePolicy" | "leavePolicyRule" | "approvalWorkflow" | "approvalLevel") =>
      (owner[m] as unknown as { count: (a: unknown) => Promise<number> }).count({ where: { companyId: A.companyId } });
    expect(await n("salaryComponent")).toBe(4);
    expect(await n("salaryTemplate")).toBe(1);
    expect(await n("shift")).toBe(1);
    expect(await n("attendanceRule")).toBe(1);
    expect(await n("companySetting")).toBe(1);
    expect(await n("leavePolicy")).toBe(1);
    expect(await n("leavePolicyRule")).toBe(3); // paid types only; Loss of Pay has no entitlement
    expect(await n("approvalWorkflow")).toBe(2); // LEAVE and RESIGNATION
    expect(await n("approvalLevel")).toBe(2);
    const shift = await owner.shift.findFirstOrThrow({ where: { companyId: A.companyId } });
    expect([shift.startMinutes, shift.endMinutes, shift.breakMinutes, shift.lateGraceMinutes]).toEqual([570, 1110, 60, 15]);
  });

  it("running the defaults again changes nothing", async () => {
    await ensureCompanyDefaults(owner, A.companyId);
    expect(await owner.salaryComponent.count({ where: { companyId: A.companyId } })).toBe(4);
    expect(await owner.leavePolicy.count({ where: { companyId: A.companyId } })).toBe(1);
    expect(await owner.approvalLevel.count({ where: { companyId: A.companyId } })).toBe(2);
  });

  it("each company's rules are its own: editing Alpha's shift leaves Bravo's alone", async () => {
    await withTenant(A.companyId, (db) => db.shift.updateMany({ where: {}, data: { startMinutes: t("10:00 AM") } }));
    const bravo = await owner.shift.findFirstOrThrow({ where: { companyId: B.companyId } });
    expect(bravo.startMinutes).toBe(570);
  });
});

/* ---------------------------------- salary structures ---------------------------------- */

describe("salary structures", () => {
  it("assigns a company-defined structure, snapshots the lines, and keeps history", async () => {
    const [template] = await withTenant(A.companyId, (db) => loadTemplates(db));
    const first = await withTenant(A.companyId, (db) =>
      assignSalary(db, A.admin, { employeeId: A.ids.employee, templateId: template.id, ctcAnnual: 600000, effectiveFrom: day("2025-04-01"), employerPfOptIn: true })
    );
    const by = Object.fromEntries(first.lines.map((l) => [l.code, l.monthlyAmount]));
    expect(by).toEqual({ BASIC: 25000, HRA: 10000, SPECIAL: 15000, OTHER: 0 });

    await withTenant(A.companyId, (db) =>
      assignSalary(db, A.admin, { employeeId: A.ids.employee, templateId: template.id, ctcAnnual: 720000, effectiveFrom: day("2026-04-01"), employerPfOptIn: true, overrides: { OTHER: 2000 } })
    );
    const rows = await owner.employeeSalary.findMany({ where: { employeeId: A.ids.employee }, orderBy: { effectiveFrom: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].effectiveTo?.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(rows[1].effectiveTo).toBeNull();
    expect(Number(rows[1].grossMonthly)).toBe(60000); // an override of 2000 on top: balance shrinks to keep within CTC
    expect(Number(rows[0].grossMonthly)).toBe(50000);
  });

  it("refuses a backdated revision and another company's structure", async () => {
    const [template] = await withTenant(A.companyId, (db) => loadTemplates(db));
    await expect(
      withTenant(A.companyId, (db) => assignSalary(db, A.admin, { employeeId: A.ids.employee, templateId: template.id, ctcAnnual: 100000, effectiveFrom: day("2025-01-01"), employerPfOptIn: true }))
    ).rejects.toThrow(/after/);
    const [bravoTemplate] = await withTenant(B.companyId, (db) => loadTemplates(db));
    await expect(
      withTenant(A.companyId, (db) => assignSalary(db, A.admin, { employeeId: A.ids.employee, templateId: bravoTemplate.id, ctcAnnual: 100000, effectiveFrom: day("2027-01-01"), employerPfOptIn: true }))
    ).rejects.toThrow(/not found/i);
  });
});

/* -------------------------------- leave: ledger + approvals -------------------------------- */

describe("leave ledger and approval flow", () => {
  it("accrues the policy entitlement into the ledger once, however often it is asked", async () => {
    await withTenant(A.companyId, (db) => ensureAccruals(db, A.companyId, A.ids.employee));
    await withTenant(A.companyId, (db) => ensureAccruals(db, A.companyId, A.ids.employee));
    await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee));
    const entries = await owner.leaveLedger.findMany({ where: { employeeId: A.ids.employee, kind: "ACCRUAL" } });
    expect(entries).toHaveLength(3); // casual, sick, earned: one each
    const balances = await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee));
    expect(balances.find((b) => b.code === "CASUAL_LEAVE")?.balance).toBe(12);
    expect(balances.find((b) => b.code === "EARNED_LEAVE")?.balance).toBe(15);
  });

  it("checks in order: policy, holidays, clashes, balance", async () => {
    const casual = await typeId(A.companyId, "CASUAL_LEAVE");
    const from = upcomingMonday();
    const preview = (over: Partial<{ leaveTypeId: string; from: string; to: string; isHalfDay: boolean }> = {}) =>
      withTenant(A.companyId, (db) => previewLeave(db, A.companyId, A.ids.employee, { leaveTypeId: casual, from, to: plusDays(from, 1), isHalfDay: false, ...over }));

    const ok = await preview();
    expect(ok).toMatchObject({ ok: true, days: 2 });
    expect(ok.available).toBe(12);

    // a holiday inside the range is not counted
    await owner.holiday.create({ data: { companyId: A.companyId, date: day(plusDays(from, 1)), name: "Test holiday" } });
    const withHoliday = await preview();
    expect(withHoliday.days).toBe(1);
    expect(withHoliday.notes.join(" ")).toMatch(/holiday/);
    await owner.holiday.deleteMany({ where: { companyId: A.companyId } });

    // Friday to next Monday skips the Sunday
    expect((await preview({ from: plusDays(from, -3), to: from })).days).toBe(3);

    expect((await preview({ to: plusDays(from, 40) })).errors.join(" ")).toMatch(/Not enough Casual Leave/);
    expect((await preview({ to: plusDays(from, -1) })).errors).toContain("The end date is before the start date");
    expect((await preview({ isHalfDay: true, to: plusDays(from, 1) })).errors).toContain("A half day can only be for a single date");
    expect((await preview({ leaveTypeId: "nope" })).errors).toContain("Choose a leave type");
  });

  it("rejects an application that clashes with existing leave", async () => {
    const casual = await typeId(A.companyId, "CASUAL_LEAVE");
    const from = upcomingMonday(3);
    await withTenant(A.companyId, (db) => submitLeave(db, A.employee, A.ids.employee, { leaveTypeId: casual, from, to: from, isHalfDay: false, reason: "test" }));
    const again = await withTenant(A.companyId, (db) => previewLeave(db, A.companyId, A.ids.employee, { leaveTypeId: casual, from, to: from, isHalfDay: false }));
    expect(again.ok).toBe(false);
    expect(again.errors.join(" ")).toMatch(/already have pending/);
    // pending days already reduce what is available
    const b = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((x) => x.code === "CASUAL_LEAVE")!;
    expect(b.pending).toBe(1);
    expect(b.available).toBe(b.balance - 1);
  });

  it("goes to the reporting manager; approval deducts the ledger and marks attendance", async () => {
    const casual = await typeId(A.companyId, "CASUAL_LEAVE");
    const from = upcomingMonday(5);
    const to = plusDays(from, 1);
    const { requestId } = await withTenant(A.companyId, (db) => submitLeave(db, A.employee, A.ids.employee, { leaveTypeId: casual, from, to, isHalfDay: false, reason: "Personal work" }));

    const approval = await owner.approvalRequest.findFirstOrThrow({ where: { entityType: "LEAVE", entityId: requestId } });
    expect(approval).toMatchObject({ status: "PENDING", currentLevel: 1 });

    // Only the manager (and HR / admin as override) can decide; the employee cannot approve their own.
    await expect(
      withTenant(A.companyId, (db) => actOnRequest(db, A.employee, { requestId: approval.id, action: "APPROVE" }, leaveApprovalHandler))
    ).rejects.toThrow(/not an approver/);
    const inbox = await withTenant(A.companyId, (db) => actionableRequests(db, A.manager, "LEAVE"));
    expect(inbox.some((i) => i.request.id === approval.id && i.route === "level")).toBe(true);

    const before = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((b) => b.code === "CASUAL_LEAVE")!.balance;
    const result = await withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "APPROVE", comment: "Fine" }, leaveApprovalHandler));
    expect(result.status).toBe("APPROVED");

    expect((await owner.leaveRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("APPROVED");
    const after = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((b) => b.code === "CASUAL_LEAVE")!.balance;
    expect(after).toBe(before - 2);
    const taken = await owner.leaveLedger.findFirstOrThrow({ where: { refId: requestId, kind: "LEAVE_TAKEN" } });
    expect(Number(taken.days)).toBe(-2);
    expect(await owner.attendanceRecord.count({ where: { employeeId: A.ids.employee, status: "ON_LEAVE", date: { in: [day(from), day(to)] } } })).toBe(2);
    expect((await owner.approvalAction.findMany({ where: { requestId: approval.id } })).map((a) => a.action)).toEqual(["APPROVE"]);

    // Revoking gives the days back and clears the On Leave marks.
    await withTenant(A.companyId, (db) => cancelLeave(db, A.hr, requestId, true));
    const restored = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((b) => b.code === "CASUAL_LEAVE")!.balance;
    expect(restored).toBe(before);
    expect(await owner.attendanceRecord.count({ where: { employeeId: A.ids.employee, status: "ON_LEAVE", date: { in: [day(from), day(to)] } } })).toBe(0);
    expect(await owner.leaveLedger.count({ where: { refId: requestId, kind: "REVERSAL" } })).toBe(1);
  });

  it("a rejected request never touches the balance", async () => {
    const casual = await typeId(A.companyId, "CASUAL_LEAVE");
    const from = upcomingMonday(7);
    const before = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((b) => b.code === "CASUAL_LEAVE")!.balance;
    const { requestId } = await withTenant(A.companyId, (db) => submitLeave(db, A.employee, A.ids.employee, { leaveTypeId: casual, from, to: from, isHalfDay: false, reason: null }));
    const approval = await owner.approvalRequest.findFirstOrThrow({ where: { entityId: requestId } });
    await withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "REJECT", comment: "Busy week" }, leaveApprovalHandler));
    expect((await owner.leaveRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("REJECTED");
    const after = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((b) => b.code === "CASUAL_LEAVE")!.balance;
    expect(after).toBe(before);
    // and it can't be decided twice
    await expect(withTenant(A.companyId, (db) => actOnRequest(db, A.hr, { requestId: approval.id, action: "APPROVE" }, leaveApprovalHandler))).rejects.toThrow(/already been decided/);
  });

  it("with no reporting manager the manager step is skipped and HR / admin decide", async () => {
    const casual = await typeId(A.companyId, "CASUAL_LEAVE");
    const from = upcomingMonday(9);
    const { requestId } = await withTenant(A.companyId, (db) => submitLeave(db, A.loner, A.ids.loner, { leaveTypeId: casual, from, to: from, isHalfDay: false, reason: null }));
    const approval = await owner.approvalRequest.findFirstOrThrow({ where: { entityId: requestId } });
    expect(approval.currentLevel).toBe(0);
    // the manager of someone else has no say
    await expect(withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "APPROVE" }, leaveApprovalHandler))).rejects.toThrow(/not an approver/);
    const done = await withTenant(A.companyId, (db) => actOnRequest(db, A.hr, { requestId: approval.id, action: "APPROVE" }, leaveApprovalHandler));
    expect(done.status).toBe("APPROVED");
    expect((await owner.approvalAction.findFirstOrThrow({ where: { requestId: approval.id } })).comment).toMatch(/override/);
  });

  it("multi-level: manager, then HR; each step must approve in turn", async () => {
    await owner.approvalLevel.create({ data: { companyId: A.companyId, workflowId: (await owner.approvalWorkflow.findFirstOrThrow({ where: { companyId: A.companyId, entityType: "LEAVE" } })).id, levelNo: 2, approverType: "ROLE", roleKey: "HR_MANAGER" } });
    const casual = await typeId(A.companyId, "CASUAL_LEAVE");
    const from = upcomingMonday(11);
    const { requestId } = await withTenant(A.companyId, (db) => submitLeave(db, A.employee, A.ids.employee, { leaveTypeId: casual, from, to: from, isHalfDay: false, reason: null }));
    const approval = await owner.approvalRequest.findFirstOrThrow({ where: { entityId: requestId } });
    expect((approval.levelsSnapshot as unknown[]).length).toBe(2);

    const first = await withTenant(A.companyId, (db) => actOnRequest(db, A.manager, { requestId: approval.id, action: "APPROVE" }, leaveApprovalHandler));
    expect(first).toMatchObject({ status: "PENDING", nextLevel: 2 });
    expect((await owner.leaveRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("PENDING");

    // the workflow is edited after submission: this request keeps its two steps
    await owner.approvalLevel.deleteMany({ where: { companyId: A.companyId } });
    const second = await withTenant(A.companyId, (db) => actOnRequest(db, A.hr, { requestId: approval.id, action: "APPROVE" }, leaveApprovalHandler));
    expect(second.status).toBe("APPROVED");
    expect((await owner.leaveRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("APPROVED");
  });

  it("setting a balance adds ONE ledger entry for the difference and never edits history", async () => {
    const sick = await typeId(A.companyId, "SICK_LEAVE");
    const before = await owner.leaveLedger.count({ where: { employeeId: A.ids.employee, leaveTypeId: sick } });
    await withTenant(A.companyId, (db) => setLeaveBalance(db, A.admin, { employeeId: A.ids.employee, leaveTypeId: sick, target: 5, note: "Migrated" }));
    expect(await owner.leaveLedger.count({ where: { employeeId: A.ids.employee, leaveTypeId: sick } })).toBe(before + 1);
    const b = (await withTenant(A.companyId, (db) => leaveBalances(db, A.companyId, A.ids.employee))).find((x) => x.code === "SICK_LEAVE")!;
    expect(b.balance).toBe(5);
  });
});

/* ----------------------------------------- attendance ----------------------------------------- */

describe("attendance from punches", () => {
  const entry = (iso: string, i: string | null, o: string | null, statusOverride: DayEntry["statusOverride"] = null): DayEntry => ({
    date: day(iso), inMinutes: i ? t(i) : null, outMinutes: o ? t(o) : null, statusOverride,
  });
  const save = (employee: { id: string; shiftId: string | null }, entries: DayEntry[], companyId = B.companyId) =>
    withTenant(companyId, (db) => saveAttendanceDays(db, companyId, employee, entries));
  const emp = () => ({ id: B.ids.employee, shiftId: null as string | null });
  const rec = (iso: string) => owner.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: B.ids.employee, date: day(iso) } } });

  it("works out status, worked hours and late marks from in/out times using the General shift", async () => {
    // 2026-03-02 is a Monday
    await save(emp(), [entry("2026-03-02", "9:30 AM", "6:30 PM"), entry("2026-03-03", "9:50 AM", "6:30 PM"), entry("2026-03-04", "9:30 AM", "1:00 PM")]);
    expect(await rec("2026-03-02")).toMatchObject({ status: "PRESENT", workedMinutes: 480, isLate: false, lateMinutes: 0 });
    expect(await rec("2026-03-03")).toMatchObject({ status: "PRESENT", isLate: true, lateMinutes: 20 });
    expect(await rec("2026-03-04")).toMatchObject({ status: "HALF_DAY" });
    const r = await rec("2026-03-02");
    expect(r.inAt?.toISOString()).toBe("2026-03-02T04:00:00.000Z"); // 09:30 IST = 04:00 UTC
  });

  it("an explicit status overrides the times; clearing an empty working day removes the record", async () => {
    await save(emp(), [entry("2026-03-05", "9:30 AM", "6:30 PM", "ABSENT")]);
    expect((await rec("2026-03-05")).status).toBe("ABSENT");
    await save(emp(), [entry("2026-03-05", null, null)]);
    expect(await owner.attendanceRecord.count({ where: { employeeId: B.ids.employee, date: day("2026-03-05") } })).toBe(0);
  });

  it("the company's own working week decides weekly offs", async () => {
    // 2026-03-08 is a Sunday: nothing entered stays empty; worked time keeps WEEK_OFF
    await save(emp(), [entry("2026-03-08", null, null)]);
    expect(await owner.attendanceRecord.count({ where: { employeeId: B.ids.employee, date: day("2026-03-08") } })).toBe(0);
    await save(emp(), [entry("2026-03-08", "10:00 AM", "2:00 PM")]);
    expect((await rec("2026-03-08")).status).toBe("WEEK_OFF");
    // Bravo switches to a Mon-Fri week: Saturday 2026-03-07 becomes an off
    await owner.attendanceRule.update({ where: { companyId: B.companyId }, data: { weeklyPattern: { mon: { mode: "WORKING" }, tue: { mode: "WORKING" }, wed: { mode: "WORKING" }, thu: { mode: "WORKING" }, fri: { mode: "WORKING" }, sat: { mode: "OFF" }, sun: { mode: "OFF" } } } });
    await save(emp(), [entry("2026-03-07", "10:00 AM", "1:00 PM")]);
    expect((await rec("2026-03-07")).status).toBe("WEEK_OFF");
  });

  it("night shift: 10 PM to 6 AM is a full day, and overtime follows the company's policy", async () => {
    const night = await owner.shift.create({ data: { companyId: B.companyId, name: "Night", startMinutes: t("10:00 PM"), endMinutes: t("6:00 AM"), breakMinutes: 0, lateGraceMinutes: 10, earlyLeaveGraceMinutes: 10 } });
    await owner.employee.update({ where: { id: B.ids.employee }, data: { shiftId: night.id } });
    await owner.attendanceRule.update({ where: { companyId: B.companyId }, data: { otEnabled: true, otPayable: true } });
    const nightEmp = { id: B.ids.employee, shiftId: night.id };
    await save(nightEmp, [entry("2026-03-10", "10:00 PM", "6:00 AM"), entry("2026-03-11", "10:00 PM", "8:00 AM")]);
    const full = await rec("2026-03-10");
    expect(full).toMatchObject({ status: "PRESENT", workedMinutes: 480, isLate: false, overtimeMinutes: 0 });
    expect(full.outAt?.toISOString()).toBe("2026-03-11T00:30:00.000Z"); // 06:00 IST next day
    expect((await rec("2026-03-11")).overtimeMinutes).toBe(120);
  });
});

/* ------------------------------------- tenant isolation ------------------------------------- */

describe("isolation of the new tables", () => {
  it("Alpha cannot see or change Bravo's shifts, components, ledger, workflows or approvals", async () => {
    const bravoShift = await owner.shift.findFirstOrThrow({ where: { companyId: B.companyId } });
    const bravoComponent = await owner.salaryComponent.findFirstOrThrow({ where: { companyId: B.companyId } });
    const bravoLedger = await owner.leaveLedger.findFirst({ where: { companyId: B.companyId } });

    expect(await withTenant(A.companyId, (db) => db.shift.findUnique({ where: { id: bravoShift.id } }))).toBeNull();
    expect(await withTenant(A.companyId, (db) => db.salaryComponent.findUnique({ where: { id: bravoComponent.id } }))).toBeNull();
    if (bravoLedger) expect(await withTenant(A.companyId, (db) => db.leaveLedger.findUnique({ where: { id: bravoLedger.id } }))).toBeNull();
    expect((await withTenant(A.companyId, (db) => db.shift.findMany())).every((s) => s.companyId === A.companyId)).toBe(true);
    expect((await withTenant(A.companyId, (db) => db.approvalWorkflow.findMany())).every((w) => w.companyId === A.companyId)).toBe(true);

    const upd = await withTenant(A.companyId, (db) => db.shift.updateMany({ where: { id: bravoShift.id }, data: { name: "Hacked" } }));
    expect(upd.count).toBe(0);
    expect((await owner.shift.findUniqueOrThrow({ where: { id: bravoShift.id } })).name).not.toBe("Hacked");
  });

  it("the database refuses cross-company references (composite keys)", async () => {
    const bravoShift = await owner.shift.findFirstOrThrow({ where: { companyId: B.companyId } });
    const bravoTemplate = await owner.salaryTemplate.findFirstOrThrow({ where: { companyId: B.companyId } });
    const bravoType = await owner.leaveType.findFirstOrThrow({ where: { companyId: B.companyId } });
    const alphaPolicy = await owner.leavePolicy.findFirstOrThrow({ where: { companyId: A.companyId } });

    await expect(owner.employee.update({ where: { id: A.ids.employee }, data: { shiftId: bravoShift.id } })).rejects.toThrow(/foreign key|constraint/i);
    await expect(
      owner.employeeSalary.create({ data: { companyId: A.companyId, employeeId: A.ids.employee, templateId: bravoTemplate.id, effectiveFrom: day("2030-01-01"), ctcAnnual: 1, grossMonthly: 1, lines: [] } })
    ).rejects.toThrow(/foreign key|constraint/i);
    await expect(
      owner.leavePolicyRule.create({ data: { companyId: A.companyId, policyId: alphaPolicy.id, leaveTypeId: bravoType.id, entitlementDays: 1 } })
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it("row-level security hides the new tables from a raw client", async () => {
    expect(await basePrisma.shift.findMany()).toHaveLength(0);
    const rows = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A.companyId}, true)`;
      return tx.leaveLedger.findMany({ where: { companyId: B.companyId } });
    });
    expect(rows).toHaveLength(0);
  });
});
