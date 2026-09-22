import type { LedgerKind } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import type { TenantCtx } from "@/server/rbac/context";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { submitForApproval, type ApprovalHandler } from "@/server/approvals/service";
import { countLeaveDays, planLedger, sumDays } from "@/lib/leave/planner";
import { isoDate } from "@/lib/attendance/calendar";

const today = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rules of the employee's leave policy (or the company default), with their leave types. */
export async function policyRulesFor(db: TenantDb, employee: { leavePolicyId: string | null }, defaultPolicyId: string | null) {
  const policyId = employee.leavePolicyId ?? defaultPolicyId;
  if (!policyId) return [];
  return db.leavePolicyRule.findMany({ where: { policyId }, include: { leaveType: true } });
}

/**
 * Makes sure the ledger has every accrual / lapse that is due up to `asOf`. Idempotent (each automatic entry
 * has a unique period), so calling it whenever balances are needed is safe. No scheduler is required.
 */
export async function ensureAccruals(db: TenantDb, companyId: string, employeeId: string, asOf: Date = today()): Promise<void> {
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, dateOfJoining: true, leavePolicyId: true, status: true },
  });
  if (!employee || employee.status === "RESIGNED" || employee.status === "TERMINATED") return;
  const { setting } = await loadRules(db, companyId);
  const rules = await policyRulesFor(db, employee, setting.defaultLeavePolicyId);

  for (const rule of rules) {
    if (!rule.leaveType.isPaid || !rule.leaveType.active) continue;
    const entries = await db.leaveLedger.findMany({ where: { employeeId, leaveTypeId: rule.leaveTypeId } });
    const plan = planLedger({
      joinDate: employee.dateOfJoining,
      asOf,
      startMonth: setting.leaveYearStartMonth,
      entries: entries.map((e) => ({ kind: e.kind, days: Number(e.days), effectiveDate: e.effectiveDate, period: e.period })),
      rule: {
        entitlementDays: Number(rule.entitlementDays),
        accrual: rule.accrual,
        carryForward: rule.carryForward,
        maxCarryForwardDays: rule.maxCarryForwardDays === null ? null : Number(rule.maxCarryForwardDays),
        maxBalance: rule.maxBalance === null ? null : Number(rule.maxBalance),
      },
    });
    if (plan.length === 0) continue;
    await db.leaveLedger.createMany({
      data: plan.map((p) => ({
        companyId, employeeId, leaveTypeId: rule.leaveTypeId, kind: p.kind, days: p.days,
        effectiveDate: p.effectiveDate, period: p.period, note: p.note,
      })),
      skipDuplicates: true,
    });
  }
}

export interface LeaveBalanceRow {
  leaveTypeId: string;
  code: string;
  name: string;
  isPaid: boolean;
  balance: number;
  /** Days on requests still awaiting a decision. */
  pending: number;
  available: number;
  entitlementDays: number | null;
}

export async function leaveBalances(db: TenantDb, companyId: string, employeeId: string): Promise<LeaveBalanceRow[]> {
  await ensureAccruals(db, companyId, employeeId);
  const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { leavePolicyId: true } });
  const { setting } = await loadRules(db, companyId);
  const rules = await policyRulesFor(db, employee ?? { leavePolicyId: null }, setting.defaultLeavePolicyId);
  const sums = await db.leaveLedger.groupBy({ by: ["leaveTypeId"], where: { employeeId }, _sum: { days: true } });
  const pendings = await db.leaveRequest.groupBy({ by: ["leaveTypeId"], where: { employeeId, status: "PENDING" }, _sum: { days: true } });

  const sumBy = new Map(sums.map((s) => [s.leaveTypeId, Number(s._sum.days ?? 0)]));
  const pendBy = new Map(pendings.map((s) => [s.leaveTypeId, Number(s._sum.days ?? 0)]));
  return rules
    .filter((r) => r.leaveType.active && r.leaveType.isPaid)
    .map((r) => {
      const balance = round2(sumBy.get(r.leaveTypeId) ?? 0);
      const pending = round2(pendBy.get(r.leaveTypeId) ?? 0);
      return {
        leaveTypeId: r.leaveTypeId, code: r.leaveType.code, name: r.leaveType.name, isPaid: true,
        balance, pending, available: round2(balance - pending), entitlementDays: Number(r.entitlementDays),
      };
    });
}

export interface LeaveApplication {
  leaveTypeId: string;
  from: string;
  to: string;
  isHalfDay: boolean;
}

export interface LeavePreview {
  ok: boolean;
  days: number;
  errors: string[];
  notes: string[];
  balance?: number;
  available?: number;
}

const parseDay = (s: string): Date | null => (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? new Date(`${s}T00:00:00Z`) : null);

/**
 * The checks an application goes through, in the order a person would ask them:
 * dates valid -> does the policy allow this leave -> how many days really count (holidays / weekly offs
 * excluded) -> any clash with existing leave -> is there enough balance.
 */
export async function previewLeave(db: TenantDb, companyId: string, employeeId: string, app: LeaveApplication): Promise<LeavePreview> {
  const errors: string[] = [];
  const notes: string[] = [];
  const fail = (): LeavePreview => ({ ok: false, days: 0, errors, notes });

  const from = parseDay(app.from);
  const to = parseDay(app.to || app.from);
  if (!from || !to) { errors.push("Choose valid dates"); return fail(); }
  if (to < from) { errors.push("The end date is before the start date"); return fail(); }
  if (app.isHalfDay && from.getTime() !== to.getTime()) { errors.push("A half day can only be for a single date"); return fail(); }

  const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { id: true, dateOfJoining: true, leavePolicyId: true, status: true } });
  const type = await db.leaveType.findUnique({ where: { id: app.leaveTypeId } });
  if (!employee) { errors.push("Employee not found"); return fail(); }
  if (employee.status === "SUSPENDED") { errors.push("This employee is currently suspended and can't apply for leave"); return fail(); }
  if (employee.status === "RESIGNED" || employee.status === "TERMINATED") { errors.push("This employee has left the company"); return fail(); }
  if (!type || !type.active) { errors.push("Choose a leave type"); return fail(); }
  if (from < employee.dateOfJoining) errors.push("The leave starts before the joining date");

  const { pattern, setting } = await loadRules(db, companyId);
  const rules = await policyRulesFor(db, employee, setting.defaultLeavePolicyId);
  const rule = rules.find((r) => r.leaveTypeId === type.id);
  if (type.isPaid && !rule) errors.push(`${type.name} is not part of your leave policy`);
  if (rule && app.isHalfDay && !rule.allowHalfDay) errors.push(`${type.name} can't be taken as a half day`);

  const holidays = await loadHolidays(db, from, to);
  const count = countLeaveDays({
    from, to, isHalfDay: app.isHalfDay, pattern, holidays,
    countWeeklyOffs: rule?.countWeeklyOffs ?? false, countHolidays: rule?.countHolidays ?? false,
  });
  if (count.skippedHolidays) notes.push(`${count.skippedHolidays} holiday${count.skippedHolidays > 1 ? "s" : ""} in this range aren't counted`);
  if (count.skippedWeeklyOffs) notes.push(`${count.skippedWeeklyOffs} weekly off${count.skippedWeeklyOffs > 1 ? "s" : ""} aren't counted`);
  if (count.days === 0) { errors.push("There are no working days in the dates you chose (they are all holidays or weekly offs)"); return { ok: false, days: 0, errors, notes }; }
  if (rule?.maxConsecutiveDays && count.days > rule.maxConsecutiveDays) errors.push(`${type.name} allows at most ${rule.maxConsecutiveDays} consecutive days`);

  const clash = await db.leaveRequest.findFirst({
    where: { employeeId, status: { in: ["PENDING", "APPROVED"] }, startDate: { lte: to }, endDate: { gte: from } },
    include: { leaveType: true },
  });
  if (clash) errors.push(`You already have ${clash.status === "APPROVED" ? "approved" : "pending"} ${clash.leaveType.name} on ${isoDate(clash.startDate)}${clash.startDate.getTime() === clash.endDate.getTime() ? "" : " to " + isoDate(clash.endDate)}`);

  let balance: number | undefined;
  let available: number | undefined;
  if (type.isPaid && rule) {
    const b = (await leaveBalances(db, companyId, employeeId)).find((x) => x.leaveTypeId === type.id);
    balance = b?.balance ?? 0;
    available = b?.available ?? 0;
    if (available < count.days) errors.push(`Not enough ${type.name}: ${available} available, ${count.days} requested`);
  } else if (!type.isPaid) {
    notes.push("Unpaid leave: it reduces salary and needs no balance");
  }
  return { ok: errors.length === 0, days: count.days, errors, notes, balance, available };
}

/** Validates, records the request and sends it into the approval workflow. */
export async function submitLeave(
  db: TenantDb,
  ctx: TenantCtx,
  employeeId: string,
  app: LeaveApplication & { reason: string | null }
): Promise<{ requestId: string }> {
  const check = await previewLeave(db, ctx.companyId, employeeId, app);
  if (!check.ok) throw new Error(check.errors.join(". "));

  const request = await db.leaveRequest.create({
    data: {
      companyId: ctx.companyId, employeeId, leaveTypeId: app.leaveTypeId,
      startDate: new Date(`${app.from}T00:00:00Z`), endDate: new Date(`${app.to || app.from}T00:00:00Z`),
      days: check.days, isHalfDay: app.isHalfDay, reason: app.reason,
    },
  });
  await submitForApproval(db, ctx, { entityType: "LEAVE", entityId: request.id, subjectEmployeeId: employeeId });
  await audit(db, ctx, {
    module: "leave", action: "leave.request", entityType: "LeaveRequest", entityId: request.id,
    newValue: { from: app.from, to: app.to || app.from, days: check.days, half: app.isHalfDay },
  });
  return { requestId: request.id };
}

/** Dates (ISO) a request charges, worked out with the current working week and the policy flags. */
async function chargeableDates(db: TenantDb, companyId: string, request: { startDate: Date; endDate: Date; isHalfDay: boolean; leaveTypeId: string; employee: { leavePolicyId: string | null } }) {
  const { pattern, setting } = await loadRules(db, companyId);
  const rules = await policyRulesFor(db, request.employee, setting.defaultLeavePolicyId);
  const rule = rules.find((r) => r.leaveTypeId === request.leaveTypeId);
  const holidays = await loadHolidays(db, request.startDate, request.endDate);
  return countLeaveDays({
    from: request.startDate, to: request.endDate, isHalfDay: request.isHalfDay, pattern, holidays,
    countWeeklyOffs: rule?.countWeeklyOffs ?? false, countHolidays: rule?.countHolidays ?? false,
  }).chargeable;
}

/** What happens to a leave request when the approval workflow finishes. */
export const leaveApprovalHandler: ApprovalHandler = {
  async onApproved(db, ctx, requestId) {
    const request = await db.leaveRequest.findUniqueOrThrow({ where: { id: requestId }, include: { leaveType: true, employee: { select: { leavePolicyId: true } } } });
    await db.leaveRequest.update({ where: { id: requestId }, data: { status: "APPROVED", decidedById: ctx.userId, decidedAt: new Date() } });

    if (request.leaveType.isPaid) {
      await db.leaveLedger.create({
        data: {
          companyId: ctx.companyId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, kind: "LEAVE_TAKEN",
          days: -Number(request.days), effectiveDate: request.startDate, refType: "LeaveRequest", refId: request.id,
          note: `${request.leaveType.name} ${isoDate(request.startDate)}${request.startDate.getTime() === request.endDate.getTime() ? "" : " to " + isoDate(request.endDate)}`,
          createdById: ctx.userId,
        },
      });
    }
    // Full-day leave shows in attendance as On Leave (without overwriting a day that has real punches).
    if (!request.isHalfDay) {
      for (const iso of await chargeableDates(db, ctx.companyId, request)) {
        const date = new Date(`${iso}T00:00:00Z`);
        const existing = await db.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: request.employeeId, date } } });
        if (!existing) await db.attendanceRecord.create({ data: { companyId: ctx.companyId, employeeId: request.employeeId, date, status: "ON_LEAVE" } });
      }
    }
  },
  async onRejected(db, ctx, requestId) {
    await db.leaveRequest.update({ where: { id: requestId }, data: { status: "REJECTED", decidedById: ctx.userId, decidedAt: new Date() } });
  },
};

/** Employee withdraws a pending request; HR (leave.manage) can also revoke an approved one, which restores the balance. */
export async function cancelLeave(db: TenantDb, ctx: TenantCtx, requestId: string, canRevoke: boolean): Promise<void> {
  const request = await db.leaveRequest.findUniqueOrThrow({ where: { id: requestId }, include: { leaveType: true, employee: { select: { leavePolicyId: true } } } });
  const own = ctx.employeeId === request.employeeId;

  if (request.status === "PENDING") {
    if (!own && !canRevoke) throw new Error("You can't cancel this request");
  } else if (request.status === "APPROVED") {
    if (!canRevoke) throw new Error("Only HR can revoke approved leave");
  } else {
    throw new Error("This request can no longer be cancelled");
  }

  if (request.status === "APPROVED") {
    if (request.leaveType.isPaid) {
      await db.leaveLedger.create({
        data: {
          companyId: ctx.companyId, employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, kind: "REVERSAL",
          days: Number(request.days), effectiveDate: today(), refType: "LeaveRequest", refId: request.id, note: "Approved leave revoked", createdById: ctx.userId,
        },
      });
    }
    for (const iso of await chargeableDates(db, ctx.companyId, request)) {
      await db.attendanceRecord.deleteMany({ where: { employeeId: request.employeeId, date: new Date(`${iso}T00:00:00Z`), status: "ON_LEAVE", inAt: null } });
    }
  }

  await db.leaveRequest.update({ where: { id: requestId }, data: { status: "CANCELLED" } });
  await db.approvalRequest.updateMany({ where: { entityType: "LEAVE", entityId: requestId, status: "PENDING" }, data: { status: "CANCELLED" } });
  await audit(db, ctx, { module: "leave", action: request.status === "APPROVED" ? "leave.revoke" : "leave.cancel", entityType: "LeaveRequest", entityId: requestId, oldValue: { status: request.status } });
}

/**
 * Sets an employee's balance for a leave type to `target` as of `asOf`, by adding one ledger entry for the
 * difference (the ledger is never edited). Used for opening balances and imports.
 */
export async function setLeaveBalance(
  db: TenantDb,
  ctx: TenantCtx,
  input: { employeeId: string; leaveTypeId: string; target: number; asOf?: Date; note?: string; kind?: LedgerKind }
): Promise<number> {
  await ensureAccruals(db, ctx.companyId, input.employeeId);
  const entries = await db.leaveLedger.findMany({ where: { employeeId: input.employeeId, leaveTypeId: input.leaveTypeId }, select: { days: true } });
  const delta = round2(input.target - sumDays(entries.map((e) => ({ days: Number(e.days) }))));
  if (delta !== 0 || entries.length === 0) {
    await db.leaveLedger.create({
      data: {
        companyId: ctx.companyId, employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, kind: input.kind ?? "OPENING", days: delta,
        effectiveDate: input.asOf ?? today(), note: input.note ?? "Balance set", createdById: ctx.userId,
      },
    });
  }
  return delta;
}

export async function adjustLeaveBalance(
  db: TenantDb,
  ctx: TenantCtx,
  input: { employeeId: string; leaveTypeId: string; days: number; note: string }
): Promise<void> {
  if (!input.days || !Number.isFinite(input.days)) throw new Error("Enter the number of days to add or remove");
  if (!input.note.trim()) throw new Error("A reason is required for an adjustment");
  await ensureAccruals(db, ctx.companyId, input.employeeId);
  const entry = await db.leaveLedger.create({
    data: {
      companyId: ctx.companyId, employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, kind: "ADJUSTMENT",
      days: round2(input.days), effectiveDate: today(), note: input.note.trim(), createdById: ctx.userId,
    },
  });
  await audit(db, ctx, { module: "leave", action: "leave.balance.adjust", entityType: "LeaveLedger", entityId: entry.id, newValue: { employeeId: input.employeeId, days: input.days, note: input.note } });
}
