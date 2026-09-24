import type { PayrollLockKind } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { can, type TenantCtx } from "@/server/rbac/context";
import { audit } from "@/server/audit/audit";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { approvedLeaveMap } from "@/server/leave/days";
import { classifyDay, eachDate, isoDate } from "@/lib/attendance/calendar";

/**
 * The pre-payroll checklist for one period: lock attendance, then loans, then other deductions, in that
 * order, before "Process payroll" is allowed. Each stage is one row in PayrollPeriodLock, keyed by
 * (company, month, year, kind). Unlocking a stage also unlocks every stage after it, so a period can never
 * be left in a state where, say, loans are locked against attendance that was subsequently reopened.
 */

const ORDER: PayrollLockKind[] = ["ATTENDANCE", "LOANS", "OTHER_DEDUCTIONS"];

function periodBounds(month: number, year: number) {
  return {
    periodStart: new Date(Date.UTC(year, month - 1, 1)),
    periodEnd: new Date(Date.UTC(year, month, 1)),
    lastDay: new Date(Date.UTC(year, month, 0)),
  };
}

async function assertNotFinalized(db: TenantDb, month: number, year: number) {
  const run = await db.payrollRun.findFirst({ where: { month, year }, select: { status: true } });
  if (run?.status === "FINALIZED") throw new Error("This period is marked as paid and can no longer be changed");
}

export interface AttendanceIssue {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** Working days in the period with no attendance record at all and no approved leave covering them. */
  missingDates: string[];
  /** Recorded, but flagged by the attendance engine (e.g. a missing in/out punch). */
  flaggedDates: string[];
}

/**
 * Working days a currently-or-formerly-employed-during-the-period person has neither a record for nor
 * approved leave covering, plus any record the attendance engine itself flagged (e.g. MISSING_PUNCH).
 * Mirrors the employee/date selection processPayrollRun uses, so what gets flagged here is exactly what
 * payroll would otherwise silently treat as absent or paid, per the company's rules.
 */
export async function attendanceIssuesFor(db: TenantDb, companyId: string, month: number, year: number): Promise<AttendanceIssue[]> {
  const { periodStart, periodEnd, lastDay } = periodBounds(month, year);
  const { pattern, setting } = await loadRules(db, companyId);
  const holidays = await loadHolidays(db, periodStart, lastDay);

  const employees = await db.employee.findMany({
    where: {
      dateOfJoining: { lt: periodEnd },
      OR: [{ dateOfExit: null }, { dateOfExit: { gte: periodStart } }],
    },
    select: {
      id: true, employeeCode: true, firstName: true, lastName: true, dateOfJoining: true, dateOfExit: true,
      attendanceRecords: { where: { date: { gte: periodStart, lt: periodEnd } }, select: { date: true, flags: true } },
      suspensions: { where: { fromDate: { lt: periodEnd }, OR: [{ toDate: null }, { toDate: { gte: periodStart } }] }, select: { fromDate: true, toDate: true } },
    },
  });
  const leaves = await approvedLeaveMap(db, employees.map((e) => e.id), periodStart, lastDay, pattern, holidays, setting.defaultLeavePolicyId);

  const issues: AttendanceIssue[] = [];
  for (const emp of employees) {
    const recordByDate = new Map(emp.attendanceRecords.map((r) => [isoDate(r.date), r]));
    const empLeaves = leaves.get(emp.id) ?? new Map();

    const excluded = new Set<string>();
    for (const s of emp.suspensions) {
      const from = s.fromDate > periodStart ? s.fromDate : periodStart;
      const to = s.toDate && s.toDate < lastDay ? s.toDate : lastDay;
      for (const d of eachDate(from, to)) excluded.add(isoDate(d));
    }
    const employedFrom = emp.dateOfJoining > periodStart ? emp.dateOfJoining : periodStart;
    const employedThrough = emp.dateOfExit && emp.dateOfExit < lastDay ? emp.dateOfExit : lastDay;

    const missingDates: string[] = [];
    const flaggedDates: string[] = [];
    for (const d of eachDate(employedFrom, employedThrough)) {
      const iso = isoDate(d);
      if (excluded.has(iso)) continue;
      if (classifyDay(d, pattern, holidays) !== "WORKING") continue;
      if (empLeaves.has(iso)) continue;
      const rec = recordByDate.get(iso);
      if (!rec) missingDates.push(iso);
      else if (rec.flags) flaggedDates.push(iso);
    }
    if (missingDates.length || flaggedDates.length) {
      issues.push({
        employeeId: emp.id, employeeCode: emp.employeeCode,
        employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
        missingDates, flaggedDates,
      });
    }
  }
  return issues;
}

export interface PeriodLockRow {
  lockedByUserId: string;
  lockedAt: Date;
  payload: unknown;
}

export interface PeriodLocks {
  attendance: PeriodLockRow | null;
  loans: PeriodLockRow | null;
  otherDeductions: PeriodLockRow | null;
}

/** The active (not-yet-unlocked) lock for each stage, or null if that stage was never locked. */
export async function getPeriodLocks(db: TenantDb, month: number, year: number): Promise<PeriodLocks> {
  const rows = await db.payrollPeriodLock.findMany({ where: { month, year, unlockedAt: null } });
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  const toRow = (k: PayrollLockKind): PeriodLockRow | null => {
    const r = byKind.get(k);
    return r ? { lockedByUserId: r.lockedByUserId, lockedAt: r.lockedAt, payload: r.payload } : null;
  };
  return { attendance: toRow("ATTENDANCE"), loans: toRow("LOANS"), otherDeductions: toRow("OTHER_DEDUCTIONS") };
}

/** The loan ids fixed by an active LOANS lock, or null if loans aren't locked for this period. */
export async function lockedLoanIds(db: TenantDb, month: number, year: number): Promise<string[] | null> {
  const locks = await getPeriodLocks(db, month, year);
  if (!locks.loans) return null;
  const payload = locks.loans.payload as { selectedLoanIds?: string[] } | null;
  return payload?.selectedLoanIds ?? [];
}

async function upsertLock(db: TenantDb, ctx: TenantCtx, month: number, year: number, kind: PayrollLockKind, payload?: unknown) {
  await db.payrollPeriodLock.upsert({
    where: { companyId_month_year_kind: { companyId: ctx.companyId, month, year, kind } },
    create: { companyId: ctx.companyId, month, year, kind, payload: payload ?? undefined, lockedByUserId: ctx.userId },
    update: { payload: payload ?? undefined, lockedByUserId: ctx.userId, lockedAt: new Date(), unlockedByUserId: null, unlockedAt: null },
  });
  await audit(db, ctx, { module: "payroll", action: "payroll.lock", entityType: "PayrollPeriodLock", entityId: `${month}-${year}-${kind}`, newValue: { month, year, kind } });
}

export async function lockAttendance(db: TenantDb, ctx: TenantCtx, month: number, year: number, acknowledgeIssues: boolean) {
  if (!can(ctx, "payroll.run", "COMPANY")) throw new Error("You don't have permission to lock attendance for payroll");
  await assertNotFinalized(db, month, year);
  const issues = await attendanceIssuesFor(db, ctx.companyId, month, year);
  if (issues.length > 0 && !acknowledgeIssues) {
    throw new Error(`${issues.length} employee(s) have missing or flagged attendance this period — review and acknowledge before locking`);
  }
  await upsertLock(db, ctx, month, year, "ATTENDANCE");
}

export async function lockLoans(db: TenantDb, ctx: TenantCtx, month: number, year: number, selectedLoanIds: string[]) {
  if (!can(ctx, "payroll.run", "COMPANY")) throw new Error("You don't have permission to lock loan deductions for payroll");
  await assertNotFinalized(db, month, year);
  const locks = await getPeriodLocks(db, month, year);
  if (!locks.attendance) throw new Error("Lock attendance for this period first");
  await upsertLock(db, ctx, month, year, "LOANS", { selectedLoanIds });
}

export async function lockOtherDeductions(db: TenantDb, ctx: TenantCtx, month: number, year: number) {
  if (!can(ctx, "payroll.run", "COMPANY")) throw new Error("You don't have permission to lock other deductions for payroll");
  await assertNotFinalized(db, month, year);
  const locks = await getPeriodLocks(db, month, year);
  if (!locks.loans) throw new Error("Lock loan & advance deductions for this period first");
  await upsertLock(db, ctx, month, year, "OTHER_DEDUCTIONS");
}

/** Unlocking a stage also unlocks every stage after it in ORDER, so the checklist never goes stale. */
export async function unlockPeriodStage(db: TenantDb, ctx: TenantCtx, month: number, year: number, kind: PayrollLockKind) {
  if (!can(ctx, "payroll.run", "COMPANY")) throw new Error("You don't have permission to unlock payroll stages");
  await assertNotFinalized(db, month, year);

  const from = ORDER.indexOf(kind);
  const toUnlock = ORDER.slice(from);
  await db.payrollPeriodLock.updateMany({
    where: { month, year, kind: { in: toUnlock }, unlockedAt: null },
    data: { unlockedByUserId: ctx.userId, unlockedAt: new Date() },
  });
  await audit(db, ctx, { module: "payroll", action: "payroll.unlock", entityType: "PayrollPeriodLock", entityId: `${month}-${year}-${kind}`, newValue: { month, year, unlocked: toUnlock } });
}

/** All three stages locked — the gate "Process payroll" checks before it will run. */
export async function allStagesLocked(db: TenantDb, month: number, year: number): Promise<boolean> {
  const locks = await getPeriodLocks(db, month, year);
  return !!(locks.attendance && locks.loans && locks.otherDeductions);
}
