import type { EmploymentStatus } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { can, type TenantCtx } from "@/server/rbac/context";
import { audit } from "@/server/audit/audit";
import { submitForApproval, cancelApprovalRequest, type ApprovalHandler } from "@/server/approvals/service";

/**
 * Employee offboarding: suspension (unpaid, temporary), resignation (employee-initiated, approved by the
 * reporting manager or HR, with an editable notice period) and termination (an employer decision, which
 * can be immediate or dated ahead). None of it deletes anything — attendance, leave and payslip history
 * stay exactly where they are; only the "current roster" view and payroll change.
 */

const today = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Statuses that mean "still on the active roster" (as opposed to fully separated). Prisma wants a plain (mutable) array here, not a readonly tuple. */
export const ROSTER_STATUSES: EmploymentStatus[] = ["ACTIVE", "ON_LEAVE", "SUSPENDED"];
/** Statuses that mean "gone" — kept in the database, shown only in the Separated report. */
export const SEPARATED_STATUSES: EmploymentStatus[] = ["RESIGNED", "TERMINATED"];

async function activeSeparation(db: TenantDb, employeeId: string) {
  return db.employeeSeparation.findFirst({ where: { employeeId, status: { in: ["PENDING", "APPROVED"] } }, orderBy: { createdAt: "desc" } });
}

/**
 * Brings `Employee.status` up to date with dates that have since arrived: a resignation/termination whose
 * last working day has passed moves the employee off the active roster; a suspension that has started
 * marks them Suspended, one that has ended returns them to Active. Nothing here needs a scheduler — call
 * it wherever the roster or a status badge is about to be shown, same as leave's `ensureAccruals`.
 */
export async function ensureLifecycleStatuses(db: TenantDb): Promise<void> {
  const asOf = today();

  const exited = await db.employee.findMany({
    where: { dateOfExit: { lt: asOf }, status: { notIn: ["RESIGNED", "TERMINATED"] } },
    select: { id: true, separations: { where: { status: "APPROVED" }, orderBy: { lastWorkingDay: "desc" }, take: 1, select: { type: true } } },
  });
  for (const e of exited) {
    const status = e.separations[0]?.type === "TERMINATION" ? "TERMINATED" : "RESIGNED";
    await db.employee.update({ where: { id: e.id }, data: { status } });
  }

  const dueToSuspend = await db.employee.findMany({
    where: {
      status: { in: ["ACTIVE", "ON_LEAVE"] },
      suspensions: { some: { fromDate: { lte: asOf }, OR: [{ toDate: null }, { toDate: { gte: asOf } }] } },
    },
    select: { id: true },
  });
  if (dueToSuspend.length) {
    await db.employee.updateMany({ where: { id: { in: dueToSuspend.map((e) => e.id) } }, data: { status: "SUSPENDED" } });
  }

  const dueToReactivate = await db.employee.findMany({
    where: { status: "SUSPENDED", suspensions: { none: { fromDate: { lte: asOf }, OR: [{ toDate: null }, { toDate: { gte: asOf } }] } } },
    select: { id: true },
  });
  if (dueToReactivate.length) {
    await db.employee.updateMany({ where: { id: { in: dueToReactivate.map((e) => e.id) } }, data: { status: "ACTIVE" } });
  }
}

/* --------------------------------------- Suspension --------------------------------------- */

export interface SuspendInput {
  employeeId: string;
  fromDate: Date;
  toDate?: Date | null;
  reason?: string | null;
}

export async function suspendEmployee(db: TenantDb, ctx: TenantCtx, input: SuspendInput): Promise<{ suspensionId: string }> {
  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, status: true } });
  if (!employee) throw new Error("Employee not found");
  if (employee.status === "RESIGNED" || employee.status === "TERMINATED") throw new Error("This employee has already left the company");
  if (input.toDate && input.toDate < input.fromDate) throw new Error("The end date is before the start date");

  // Two ranges [a.from, a.to] and [b.from, b.to] (either end open) overlap iff a.from <= b.to and b.from <= a.to.
  // Done in JS rather than SQL: an employee has at most a handful of suspensions ever, and an open ("to"
  // is null) end doesn't translate cleanly to a single comparable bound.
  const existing = await db.employeeSuspension.findMany({ where: { employeeId: input.employeeId }, select: { id: true, fromDate: true, toDate: true } });
  const overlapping = existing.some(
    (s) => input.fromDate <= (s.toDate ?? input.fromDate) && s.fromDate <= (input.toDate ?? s.fromDate)
  );
  if (overlapping) throw new Error("This employee already has a suspension that overlaps these dates");

  const suspension = await db.employeeSuspension.create({
    data: {
      companyId: ctx.companyId, employeeId: input.employeeId, fromDate: input.fromDate, toDate: input.toDate ?? null,
      reason: input.reason || null, createdByUserId: ctx.userId,
    },
  });
  if (input.fromDate <= today() && (!input.toDate || input.toDate >= today())) {
    await db.employee.update({ where: { id: input.employeeId }, data: { status: "SUSPENDED" } });
  }
  await audit(db, ctx, {
    module: "employees", action: "employee.suspend", entityType: "Employee", entityId: input.employeeId,
    newValue: { employeeCode: employee.employeeCode, fromDate: input.fromDate, toDate: input.toDate ?? null, reason: input.reason },
  });
  return { suspensionId: suspension.id };
}

/**
 * Ends an open suspension (defaults to today) and reinstates the employee if nothing else keeps them
 * suspended. `toDate` is the LAST suspended day, same as everywhere else here — ending it "today" means
 * today is still unpaid and they're back from tomorrow; `ensureLifecycleStatuses` picks that up the next
 * time anything is loaded. Only a `toDate` that's already in the past reinstates them right away.
 */
export async function endSuspension(db: TenantDb, ctx: TenantCtx, input: { suspensionId: string; toDate?: Date }): Promise<void> {
  const suspension = await db.employeeSuspension.findUnique({ where: { id: input.suspensionId } });
  if (!suspension) throw new Error("Suspension not found");
  const toDate = input.toDate ?? today();
  if (toDate < suspension.fromDate) throw new Error("The end date is before the start date");

  await db.employeeSuspension.update({ where: { id: suspension.id }, data: { toDate } });

  if (toDate < today()) {
    const stillOpen = await db.employeeSuspension.findFirst({
      where: { employeeId: suspension.employeeId, id: { not: suspension.id }, fromDate: { lte: today() }, OR: [{ toDate: null }, { toDate: { gte: today() } }] },
    });
    if (!stillOpen) {
      const employee = await db.employee.findUnique({ where: { id: suspension.employeeId }, select: { status: true } });
      if (employee?.status === "SUSPENDED") await db.employee.update({ where: { id: suspension.employeeId }, data: { status: "ACTIVE" } });
    }
  }
  await audit(db, ctx, {
    module: "employees", action: "employee.reinstate", entityType: "Employee", entityId: suspension.employeeId,
    oldValue: { toDate: suspension.toDate }, newValue: { toDate },
  });
}

/* --------------------------------------- Resignation --------------------------------------- */

export interface SubmitResignationInput {
  employeeId: string;
  submittedDate: Date;
  noticePeriodDays: number;
  reason?: string | null;
}

export async function submitResignation(db: TenantDb, ctx: TenantCtx, input: SubmitResignationInput): Promise<{ separationId: string }> {
  if (!(input.noticePeriodDays >= 0)) throw new Error("Notice period must be zero or more days");
  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, status: true } });
  if (!employee) throw new Error("Employee not found");
  if (employee.status === "RESIGNED" || employee.status === "TERMINATED") throw new Error("This employee has already left the company");
  if (await activeSeparation(db, input.employeeId)) throw new Error("There is already a resignation or termination on file for this employee — withdraw it first");

  const lastWorkingDay = addDays(input.submittedDate, input.noticePeriodDays);
  const separation = await db.employeeSeparation.create({
    data: {
      companyId: ctx.companyId, employeeId: input.employeeId, type: "RESIGNATION", status: "PENDING",
      submittedDate: input.submittedDate, noticePeriodDays: input.noticePeriodDays, lastWorkingDay,
      reason: input.reason || null, requestedByUserId: ctx.userId,
    },
  });
  await submitForApproval(db, ctx, { entityType: "RESIGNATION", entityId: separation.id, subjectEmployeeId: input.employeeId });
  await audit(db, ctx, {
    module: "employees", action: "resignation.submit", entityType: "EmployeeSeparation", entityId: separation.id,
    newValue: { employeeCode: employee.employeeCode, submittedDate: input.submittedDate, noticePeriodDays: input.noticePeriodDays, lastWorkingDay },
  });
  return { separationId: separation.id };
}

/** Changes the notice period (or the last working day directly). Recomputes `Employee.dateOfExit` if this resignation is already approved. */
export async function updateResignationNotice(
  db: TenantDb,
  ctx: TenantCtx,
  input: { separationId: string; noticePeriodDays?: number; lastWorkingDay?: Date }
): Promise<void> {
  const sep = await db.employeeSeparation.findUnique({ where: { id: input.separationId } });
  if (!sep || sep.type !== "RESIGNATION") throw new Error("Resignation not found");
  if (sep.status !== "PENDING" && sep.status !== "APPROVED") throw new Error("This resignation has already been decided or withdrawn");
  if (input.noticePeriodDays != null && !(input.noticePeriodDays >= 0)) throw new Error("Notice period must be zero or more days");

  const noticePeriodDays = input.noticePeriodDays ?? sep.noticePeriodDays;
  const lastWorkingDay = input.lastWorkingDay ?? (input.noticePeriodDays != null ? addDays(sep.submittedDate, input.noticePeriodDays) : sep.lastWorkingDay);

  await db.employeeSeparation.update({ where: { id: sep.id }, data: { noticePeriodDays, lastWorkingDay } });
  if (sep.status === "APPROVED") {
    await db.employee.update({
      where: { id: sep.employeeId },
      data: { dateOfExit: lastWorkingDay, status: lastWorkingDay < today() ? "RESIGNED" : "ACTIVE" },
    });
  }
  await audit(db, ctx, {
    module: "employees", action: "resignation.update_notice", entityType: "EmployeeSeparation", entityId: sep.id,
    oldValue: { noticePeriodDays: sep.noticePeriodDays, lastWorkingDay: sep.lastWorkingDay },
    newValue: { noticePeriodDays, lastWorkingDay },
  });
}

/** The employee (or HR/admin) changes their mind before the last working day. */
export async function withdrawResignation(db: TenantDb, ctx: TenantCtx, separationId: string): Promise<void> {
  const sep = await db.employeeSeparation.findUnique({ where: { id: separationId } });
  if (!sep || sep.type !== "RESIGNATION") throw new Error("Resignation not found");
  if (sep.status !== "PENDING" && sep.status !== "APPROVED") throw new Error("This resignation has already been decided or withdrawn");
  if (sep.status === "APPROVED" && sep.lastWorkingDay < today()) throw new Error("The last working day has already passed");

  const isSelf = !!ctx.employeeId && ctx.employeeId === sep.employeeId;
  if (!isSelf && !can(ctx, "employee.offboard", "COMPANY")) throw new Error("You can't withdraw this resignation");

  await db.employeeSeparation.update({ where: { id: sep.id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedByUserId: ctx.userId } });
  await cancelApprovalRequest(db, ctx, "RESIGNATION", sep.id);
  await db.employee.update({ where: { id: sep.employeeId }, data: { dateOfExit: null, status: "ACTIVE" } });
  await audit(db, ctx, { module: "employees", action: "resignation.withdraw", entityType: "EmployeeSeparation", entityId: sep.id, oldValue: { status: sep.status } });
}

/** Applies the approve/reject decision to the resignation record and, on approval, the employee's exit date. */
export const resignationApprovalHandler: ApprovalHandler = {
  async onApproved(db, ctx, entityId) {
    const sep = await db.employeeSeparation.findUnique({ where: { id: entityId } });
    if (!sep || sep.status !== "PENDING") return; // withdrawn in the meantime — nothing to do
    await db.employeeSeparation.update({ where: { id: sep.id }, data: { status: "APPROVED", decidedAt: new Date(), decidedByUserId: ctx.userId } });
    await db.employee.update({
      where: { id: sep.employeeId },
      data: { dateOfExit: sep.lastWorkingDay, ...(sep.lastWorkingDay < today() ? { status: "RESIGNED" } : {}) },
    });
    await audit(db, ctx, {
      module: "employees", action: "resignation.approve", entityType: "EmployeeSeparation", entityId: sep.id,
      newValue: { lastWorkingDay: sep.lastWorkingDay },
    });
  },
  async onRejected(db, ctx, entityId) {
    const sep = await db.employeeSeparation.findUnique({ where: { id: entityId } });
    if (!sep || sep.status !== "PENDING") return;
    await db.employeeSeparation.update({ where: { id: sep.id }, data: { status: "REJECTED", decidedAt: new Date(), decidedByUserId: ctx.userId } });
    await audit(db, ctx, { module: "employees", action: "resignation.reject", entityType: "EmployeeSeparation", entityId: sep.id });
  },
};

/* --------------------------------------- Termination --------------------------------------- */

export interface TerminateInput {
  employeeId: string;
  terminationDate: Date;
  reason?: string | null;
}

/** An employer decision — no approval step. `terminationDate` may be today, in the past (backdated) or in the future. */
export async function terminateEmployee(db: TenantDb, ctx: TenantCtx, input: TerminateInput): Promise<{ separationId: string }> {
  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, status: true } });
  if (!employee) throw new Error("Employee not found");
  if (employee.status === "RESIGNED" || employee.status === "TERMINATED") throw new Error("This employee has already left the company");
  if (await activeSeparation(db, input.employeeId)) throw new Error("There is already a resignation or termination on file for this employee — withdraw it first");

  const separation = await db.employeeSeparation.create({
    data: {
      companyId: ctx.companyId, employeeId: input.employeeId, type: "TERMINATION", status: "APPROVED",
      submittedDate: today(), lastWorkingDay: input.terminationDate, reason: input.reason || null,
      requestedByUserId: ctx.userId, decidedByUserId: ctx.userId, decidedAt: new Date(),
    },
  });
  await db.employee.update({
    where: { id: input.employeeId },
    data: { dateOfExit: input.terminationDate, ...(input.terminationDate <= today() ? { status: "TERMINATED" } : {}) },
  });
  await audit(db, ctx, {
    module: "employees", action: "employee.terminate", entityType: "EmployeeSeparation", entityId: separation.id,
    newValue: { employeeCode: employee.employeeCode, terminationDate: input.terminationDate, reason: input.reason },
  });
  return { separationId: separation.id };
}
