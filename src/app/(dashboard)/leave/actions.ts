"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { actOnRequest } from "@/server/approvals/service";
import {
  adjustLeaveBalance,
  cancelLeave,
  leaveApprovalHandler,
  previewLeave,
  submitLeave,
  type LeaveApplication,
  type LeavePreview,
} from "@/server/leave/service";

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

function readApplication(input: { leaveTypeId?: unknown; from?: unknown; to?: unknown; half?: unknown }): LeaveApplication {
  return {
    leaveTypeId: String(input.leaveTypeId ?? ""),
    from: String(input.from ?? ""),
    to: String(input.to || input.from || ""),
    isHalfDay: input.half === true || input.half === "on" || input.half === "true",
  };
}

/** Runs the same checks as submitting, without saving: powers the live "what will happen" panel on the form. */
export async function previewLeaveAction(input: { leaveTypeId: string; from: string; to: string; half: boolean }): Promise<LeavePreview> {
  const ctx = await assertPermission("leave.request", "OWN");
  if (!ctx.employeeId) return { ok: false, days: 0, errors: ["No employee profile is linked to this account"], notes: [] };
  return withTenant(ctx.companyId, (db) => previewLeave(db, ctx.companyId, ctx.employeeId!, readApplication(input)));
}

export async function applyLeaveAction(formData: FormData): Promise<ApplyResult> {
  const ctx = await assertPermission("leave.request", "OWN");
  if (!ctx.employeeId) return { ok: false, error: "No employee profile is linked to this account" };
  const reason = String(formData.get("reason") ?? "").trim();
  try {
    await withTenant(ctx.companyId, (db) =>
      submitLeave(db, ctx, ctx.employeeId!, {
        ...readApplication({ leaveTypeId: formData.get("leaveTypeId"), from: formData.get("from"), to: formData.get("to"), half: formData.get("half") }),
        reason: reason || null,
      })
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't submit the request" };
  }
  revalidatePath("/leave");
  revalidatePath("/dashboard");
  return { ok: true };
}

/** Approve or reject from the approver's inbox. `decision` and `comment` come from the form. */
export async function decideLeaveAction(requestId: string, formData: FormData) {
  const ctx = await assertPermission("leave.approve", "TEAM");
  const decision = formData.get("decision") === "REJECT" ? "REJECT" : "APPROVE";
  const comment = String(formData.get("comment") ?? "").trim();

  await withTenant(ctx.companyId, async (db) => {
    const approval = await db.approvalRequest.findUnique({ where: { entityType_entityId: { entityType: "LEAVE", entityId: requestId } } });
    if (approval) {
      await actOnRequest(db, ctx, { requestId: approval.id, action: decision, comment }, leaveApprovalHandler);
      return;
    }
    // Requests made before approval workflows existed have no workflow: HR / admins decide them directly.
    if (!can(ctx, "leave.approve", "COMPANY")) throw new Error("Only HR can decide this request");
    const request = await db.leaveRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "PENDING") throw new Error("This request has already been decided");
    if (request.employeeId === ctx.employeeId) throw new Error("You can't decide your own leave request");
    if (decision === "APPROVE") await leaveApprovalHandler.onApproved(db, ctx, requestId);
    else await leaveApprovalHandler.onRejected(db, ctx, requestId);
  });

  revalidatePath("/leave");
  revalidatePath("/attendance");
  revalidatePath("/dashboard");
}

export async function cancelLeaveAction(requestId: string) {
  const ctx = await assertPermission("leave.read", "OWN");
  await withTenant(ctx.companyId, (db) => cancelLeave(db, ctx, requestId, can(ctx, "leave.manage", "COMPANY")));
  revalidatePath("/leave");
  revalidatePath("/attendance");
}

export async function adjustBalanceAction(formData: FormData) {
  const ctx = await assertPermission("leave.manage", "COMPANY");
  const employeeId = String(formData.get("employeeId") ?? "");
  await withTenant(ctx.companyId, async (db) => {
    const type = await db.leaveType.findUnique({ where: { id: String(formData.get("leaveTypeId") ?? "") } });
    if (!type || !type.isPaid) throw new Error("Choose a paid leave type");
    if (!(await db.employee.findUnique({ where: { id: employeeId }, select: { id: true } }))) throw new Error("Employee not found");
    await adjustLeaveBalance(db, ctx, {
      employeeId, leaveTypeId: type.id, days: Number(formData.get("days")), note: String(formData.get("note") ?? ""),
    });
  });
  revalidatePath("/leave/balances");
}
