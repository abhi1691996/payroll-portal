"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, getContext } from "@/server/rbac/guard";
import { can, type TenantCtx } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { actOnRequest } from "@/server/approvals/service";
import {
  endSuspension,
  resignationApprovalHandler,
  submitResignation,
  suspendEmployee,
  terminateEmployee,
  updateResignationNotice,
  withdrawResignation,
} from "@/server/employees/lifecycle";

const parseDay = (value: FormDataEntryValue | null): Date | null => {
  const s = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T00:00:00Z`);
};

function revalidateRoster(employeeId: string) {
  revalidatePath(`/employees/${employeeId}`);
  revalidatePath("/employees");
  revalidatePath("/employees/separated");
  revalidatePath("/dashboard");
}

/* ------------------------------------- Suspension ------------------------------------- */

export async function suspendEmployeeAction(employeeId: string, formData: FormData) {
  const ctx = await assertPermission("employee.offboard", "COMPANY");
  const fromDate = parseDay(formData.get("fromDate"));
  const toDate = parseDay(formData.get("toDate"));
  if (!fromDate) throw new Error("Choose a start date");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  await withTenant(ctx.companyId, (db) => suspendEmployee(db, ctx, { employeeId, fromDate, toDate, reason }));
  revalidateRoster(employeeId);
}

export async function endSuspensionAction(employeeId: string, suspensionId: string, formData: FormData) {
  const ctx = await assertPermission("employee.offboard", "COMPANY");
  const toDate = parseDay(formData.get("toDate")) ?? undefined;

  await withTenant(ctx.companyId, (db) => endSuspension(db, ctx, { suspensionId, toDate }));
  revalidateRoster(employeeId);
}

/* ------------------------------------- Resignation ------------------------------------- */

/** The employee applies for their own resignation, or HR/an admin records one on their behalf. */
export async function submitResignationAction(employeeId: string, formData: FormData) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) throw new Error("Not signed in");
  const tenantCtx = ctx as TenantCtx;
  const isSelf = tenantCtx.employeeId === employeeId;
  if (!((isSelf && can(tenantCtx, "resignation.request", "OWN")) || can(tenantCtx, "employee.offboard", "COMPANY"))) {
    throw new Error("You can't submit a resignation for this employee");
  }

  const submittedDate = parseDay(formData.get("submittedDate"));
  if (!submittedDate) throw new Error("Choose the date of resignation");
  const noticePeriodDays = Number(formData.get("noticePeriodDays"));
  if (!Number.isFinite(noticePeriodDays) || noticePeriodDays < 0) throw new Error("Notice period must be zero or more days");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  await withTenant(ctx.companyId, (db) => submitResignation(db, tenantCtx, { employeeId, submittedDate, noticePeriodDays, reason }));
  revalidateRoster(employeeId);
}

/** HR/admin edits the notice period (or the last working day directly) — before or after approval. */
export async function updateResignationNoticeAction(employeeId: string, separationId: string, formData: FormData) {
  const ctx = await assertPermission("employee.offboard", "COMPANY");
  const noticePeriodDays = formData.get("noticePeriodDays") ? Number(formData.get("noticePeriodDays")) : undefined;
  if (noticePeriodDays != null && (!Number.isFinite(noticePeriodDays) || noticePeriodDays < 0)) {
    throw new Error("Notice period must be zero or more days");
  }
  const lastWorkingDay = formData.get("lastWorkingDay") ? (parseDay(formData.get("lastWorkingDay")) ?? undefined) : undefined;

  await withTenant(ctx.companyId, (db) => updateResignationNotice(db, ctx, { separationId, noticePeriodDays, lastWorkingDay }));
  revalidateRoster(employeeId);
}

/** The employee (or HR/admin) changes their mind before the last working day. */
export async function withdrawResignationAction(employeeId: string, separationId: string) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) throw new Error("Not signed in");

  await withTenant(ctx.companyId, (db) => withdrawResignation(db, ctx as TenantCtx, separationId));
  revalidateRoster(employeeId);
}

/** Approve or reject a pending resignation, from wherever it's decided (the employee's profile page). */
export async function decideResignationAction(employeeId: string, approvalRequestId: string, formData: FormData) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) throw new Error("Not signed in");
  const decision = formData.get("decision") === "REJECT" ? "REJECT" : "APPROVE";
  const comment = String(formData.get("comment") ?? "").trim();

  await withTenant(ctx.companyId, (db) =>
    actOnRequest(db, ctx as TenantCtx, { requestId: approvalRequestId, action: decision, comment }, resignationApprovalHandler)
  );
  revalidateRoster(employeeId);
}

/* ------------------------------------- Termination ------------------------------------- */

export async function terminateEmployeeAction(employeeId: string, formData: FormData) {
  const ctx = await assertPermission("employee.offboard", "COMPANY");
  const terminationDate = parseDay(formData.get("terminationDate"));
  if (!terminationDate) throw new Error("Choose the effective date");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  await withTenant(ctx.companyId, (db) => terminateEmployee(db, ctx, { employeeId, terminationDate, reason }));
  revalidateRoster(employeeId);
}
