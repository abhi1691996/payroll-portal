import type { Prisma, PermissionScope } from "@prisma/client";
import type { PermissionKey } from "./permissions";

/** Who is making this request. Built fresh from the database on every request. */
export interface Ctx {
  userId: string;
  email: string;
  name: string | null;
  /** null only for platform users. */
  companyId: string | null;
  isSuperAdmin: boolean;
  /** The Employee record linked to this login, if any. */
  employeeId: string | null;
  roleKeys: string[];
  permissions: Map<PermissionKey, PermissionScope>;
  ip: string | null;
  userAgent: string | null;
}

/** A Ctx that is known to belong to a company. */
export type TenantCtx = Ctx & { companyId: string };

const RANK: Record<PermissionScope, number> = { OWN: 1, TEAM: 2, COMPANY: 3 };

export function scopeRank(scope: PermissionScope | null | undefined): number {
  return scope ? RANK[scope] : 0;
}

/** Combines grants from several roles: the widest scope wins for each permission. */
export function mergeGrants(
  rows: { permissionKey: string; scope: PermissionScope }[]
): Map<PermissionKey, PermissionScope> {
  const merged = new Map<PermissionKey, PermissionScope>();
  for (const { permissionKey, scope } of rows) {
    const current = merged.get(permissionKey as PermissionKey);
    if (scopeRank(scope) > scopeRank(current)) merged.set(permissionKey as PermissionKey, scope);
  }
  return merged;
}

export function scopeOf(ctx: Pick<Ctx, "permissions">, key: PermissionKey): PermissionScope | null {
  return ctx.permissions.get(key) ?? null;
}

/** True if the user holds the permission at `minScope` or wider. */
export function can(
  ctx: Pick<Ctx, "permissions">,
  key: PermissionKey,
  minScope: PermissionScope = "OWN"
): boolean {
  return scopeRank(scopeOf(ctx, key)) >= scopeRank(minScope);
}

/**
 * Prisma filter restricting Employee rows to those the user may see for this permission:
 *   COMPANY -> everyone (the tenant client already limits to the company)
 *   TEAM    -> direct reports
 *   OWN     -> just themselves
 * No grant (or no linked employee record where one is needed) -> matches nothing.
 */
export function employeeScopeWhere(
  ctx: Pick<Ctx, "permissions" | "employeeId">,
  key: PermissionKey
): Prisma.EmployeeWhereInput {
  const scope = scopeOf(ctx, key);
  if (scope === "COMPANY") return {};
  if (!ctx.employeeId) return { id: "__none__" };
  if (scope === "TEAM") return { managerId: ctx.employeeId };
  if (scope === "OWN") return { id: ctx.employeeId };
  return { id: "__none__" };
}

export class ForbiddenError extends Error {
  constructor(message = "You don't have permission to do that") {
    super(message);
    this.name = "ForbiddenError";
  }
}
