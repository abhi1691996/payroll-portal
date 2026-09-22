import type { ApprovalActionType, ApproverType, Prisma } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { can, type TenantCtx } from "@/server/rbac/context";
import type { PermissionKey } from "@/server/rbac/permissions";

/**
 * A small, generic approval engine. A company configures, per kind of request, an ordered list of levels;
 * each level names who approves: the employee's reporting manager, or anyone holding a role (e.g. HR).
 * Domain modules (leave today) submit a request and provide a handler for the outcome, so approval logic
 * never lives inside them.
 */
export interface LevelSnapshot {
  levelNo: number;
  approverType: ApproverType;
  roleKey: string | null;
}

/** Who may step in and decide any request of a kind, whatever level it is on (HR / admins). */
const OVERRIDE_PERMISSION: Record<string, PermissionKey> = { LEAVE: "leave.approve", RESIGNATION: "employee.offboard" };

export interface ApprovalHandler {
  onApproved(db: TenantDb, ctx: TenantCtx, entityId: string): Promise<void>;
  onRejected(db: TenantDb, ctx: TenantCtx, entityId: string): Promise<void>;
}

async function subjectManagerId(db: TenantDb, subjectEmployeeId: string | null): Promise<string | null> {
  if (!subjectEmployeeId) return null;
  return (await db.employee.findUnique({ where: { id: subjectEmployeeId }, select: { managerId: true } }))?.managerId ?? null;
}

/** First level at or after `from` that can actually be resolved for this employee (e.g. has a manager). 0 = none. */
function firstResolvable(levels: LevelSnapshot[], from: number, managerId: string | null): number {
  for (const l of [...levels].sort((a, b) => a.levelNo - b.levelNo)) {
    if (l.levelNo < from) continue;
    if (l.approverType === "REPORTING_MANAGER" && !managerId) continue; // no manager: skip this level
    return l.levelNo;
  }
  return 0;
}

export async function submitForApproval(
  db: TenantDb,
  ctx: TenantCtx,
  input: { entityType: string; entityId: string; subjectEmployeeId: string | null }
): Promise<{ requestId: string; currentLevel: number }> {
  const workflow = await db.approvalWorkflow.findFirst({
    where: { entityType: input.entityType, active: true },
    include: { levels: { orderBy: { levelNo: "asc" } } },
  });
  const levels: LevelSnapshot[] = (workflow?.levels ?? []).map((l) => ({
    levelNo: l.levelNo, approverType: l.approverType, roleKey: l.roleKey,
  }));
  const managerId = await subjectManagerId(db, input.subjectEmployeeId);
  const currentLevel = firstResolvable(levels, 1, managerId);

  const request = await db.approvalRequest.create({
    data: {
      companyId: ctx.companyId,
      entityType: input.entityType,
      entityId: input.entityId,
      requestedByUserId: ctx.userId,
      subjectEmployeeId: input.subjectEmployeeId,
      currentLevel,
      levelsSnapshot: levels as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(db, ctx, {
    module: "approvals",
    action: "approval.submit",
    entityType: input.entityType,
    entityId: input.entityId,
    newValue: { requestId: request.id, levels: levels.length },
  });
  return { requestId: request.id, currentLevel };
}

type PendingRequest = { entityType: string; status: string; currentLevel: number; levelsSnapshot: unknown; subjectEmployeeId: string | null };

/** How (if at all) the signed-in user may decide this request. */
export function decisionRoute(
  ctx: TenantCtx,
  request: PendingRequest,
  managerId: string | null
): "level" | "override" | null {
  if (request.status !== "PENDING") return null;
  if (request.subjectEmployeeId && request.subjectEmployeeId === ctx.employeeId) return null; // never your own
  const levels = (request.levelsSnapshot ?? []) as unknown as LevelSnapshot[];
  const current = levels.find((l) => l.levelNo === request.currentLevel);
  if (current) {
    if (current.approverType === "REPORTING_MANAGER" && managerId && managerId === ctx.employeeId) return "level";
    if (current.approverType === "ROLE" && current.roleKey && ctx.roleKeys.includes(current.roleKey)) return "level";
  }
  const override = OVERRIDE_PERMISSION[request.entityType];
  if (override && can(ctx, override, "COMPANY")) return "override";
  return null;
}

export async function actOnRequest(
  db: TenantDb,
  ctx: TenantCtx,
  input: { requestId: string; action: "APPROVE" | "REJECT"; comment?: string },
  handler: ApprovalHandler
): Promise<{ status: "PENDING" | "APPROVED" | "REJECTED"; nextLevel?: number }> {
  const request = await db.approvalRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new Error("Request not found");
  if (request.status !== "PENDING") throw new Error("This request has already been decided");

  const managerId = await subjectManagerId(db, request.subjectEmployeeId);
  const route = decisionRoute(ctx, request, managerId);
  if (!route) throw new Error("You are not an approver for this request");

  const levels = (request.levelsSnapshot ?? []) as unknown as LevelSnapshot[];
  const actorName = ctx.name ?? ctx.email;
  const record = (action: ApprovalActionType, comment?: string) =>
    db.approvalAction.create({
      data: { companyId: ctx.companyId, requestId: request.id, levelNo: request.currentLevel, actorUserId: ctx.userId, actorName, action, comment: comment || null },
    });

  let status: "PENDING" | "APPROVED" | "REJECTED" = "PENDING";
  let nextLevel: number | undefined;

  if (input.action === "REJECT") {
    status = "REJECTED";
    await record("REJECT", input.comment);
  } else if (route === "override") {
    // HR / admin decides regardless of level: that is the final approval.
    status = "APPROVED";
    await record("APPROVE", `${input.comment ? input.comment + " — " : ""}approved by ${actorName} (override)`);
  } else {
    await record("APPROVE", input.comment);
    nextLevel = firstResolvable(levels, request.currentLevel + 1, managerId);
    status = nextLevel === 0 ? "APPROVED" : "PENDING";
  }

  await db.approvalRequest.update({
    where: { id: request.id },
    data: { status, ...(status === "PENDING" ? { currentLevel: nextLevel } : {}) },
  });
  if (status === "APPROVED") await handler.onApproved(db, ctx, request.entityId);
  if (status === "REJECTED") await handler.onRejected(db, ctx, request.entityId);

  await audit(db, ctx, {
    module: "approvals",
    action: `approval.${input.action.toLowerCase()}`,
    entityType: request.entityType,
    entityId: request.entityId,
    oldValue: { status: request.status, level: request.currentLevel },
    newValue: { status, level: nextLevel ?? request.currentLevel, route, comment: input.comment },
  });
  return { status, nextLevel };
}

/**
 * Withdraws a still-pending request on the domain module's own say-so (e.g. the employee withdrew
 * their resignation). Not a decision, so it bypasses `decisionRoute` — the caller has already checked
 * whoever asked for this is allowed to. A no-op if the request is no longer pending.
 */
export async function cancelApprovalRequest(db: TenantDb, ctx: TenantCtx, entityType: string, entityId: string): Promise<void> {
  const request = await db.approvalRequest.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  if (!request || request.status !== "PENDING") return;
  await db.approvalRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } });
  await audit(db, ctx, {
    module: "approvals", action: "approval.cancel", entityType, entityId,
    oldValue: { status: request.status }, newValue: { status: "CANCELLED" },
  });
}

/** Pending requests the signed-in user may decide right now, with how they qualify. */
export async function actionableRequests(db: TenantDb, ctx: TenantCtx, entityType: string) {
  const pending = await db.approvalRequest.findMany({ where: { entityType, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 300 });
  const subjectIds = [...new Set(pending.map((p) => p.subjectEmployeeId).filter((x): x is string => !!x))];
  const managers = new Map(
    (await db.employee.findMany({ where: { id: { in: subjectIds } }, select: { id: true, managerId: true } })).map((e) => [e.id, e.managerId])
  );
  return pending
    .map((r) => ({ request: r, route: decisionRoute(ctx, r, r.subjectEmployeeId ? (managers.get(r.subjectEmployeeId) ?? null) : null) }))
    .filter((x): x is { request: (typeof pending)[number]; route: "level" | "override" } => x.route !== null);
}
