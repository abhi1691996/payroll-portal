import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { PermissionScope } from "@prisma/client";
import { auth } from "@/auth";
import { withPlatform } from "@/server/tenancy/db";
import {
  ForbiddenError,
  can,
  mergeGrants,
  type Ctx,
  type TenantCtx,
} from "./context";
import type { PermissionKey } from "./permissions";

/**
 * Builds the request context from the database (NOT from the session cookie), so removing a role,
 * disabling a user or suspending a company takes effect on the very next request.
 * Returns null when there is no valid, active user.
 */
export const getContext = cache(async (): Promise<Ctx | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const user = await withPlatform((db) =>
    db.user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { id: true, status: true } },
        employee: { select: { id: true } },
        userRoles: {
          include: { role: { include: { permissions: { select: { permissionKey: true, scope: true } } } } },
        },
      },
    })
  );

  if (!user || user.status !== "ACTIVE") return null;
  if (user.company && user.company.status === "SUSPENDED") return null;

  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip");
    userAgent = h.get("user-agent");
  } catch {
    // Outside a request (scripts/tests): no client info.
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    companyId: user.companyId,
    isSuperAdmin: user.platformRole === "SUPER_ADMIN",
    employeeId: user.employee?.id ?? null,
    roleKeys: user.userRoles.map((ur) => ur.role.key),
    permissions: mergeGrants(user.userRoles.flatMap((ur) => ur.role.permissions)),
    ip,
    userAgent,
  };
});

/* ------------------------------ Pages (redirect) --------------------------- */

/** Signed-in user of any kind, or redirect to /login. */
export async function requireContext(): Promise<Ctx> {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** Signed-in company user (Super Admins are sent to their own portal). */
export async function requireTenant(): Promise<TenantCtx> {
  const ctx = await requireContext();
  if (ctx.isSuperAdmin || !ctx.companyId) redirect("/platform");
  return ctx as TenantCtx;
}

/** Page guard: company user holding `key` at `minScope` or wider, else back to the dashboard. */
export async function requirePermission(
  key: PermissionKey,
  minScope: PermissionScope = "OWN"
): Promise<TenantCtx> {
  const ctx = await requireTenant();
  if (!can(ctx, key, minScope)) redirect("/dashboard");
  return ctx;
}

/** Super Admin only, else redirect. */
export async function requireSuperAdmin(): Promise<Ctx> {
  const ctx = await requireContext();
  if (!ctx.isSuperAdmin) redirect("/dashboard");
  return ctx;
}

/* --------------------------- Actions / route handlers (throw) -------------- */

/** Server Action guard: throws instead of redirecting so the caller sees a failure, not a page. */
export async function assertPermission(
  key: PermissionKey,
  minScope: PermissionScope = "OWN"
): Promise<TenantCtx> {
  const ctx = await getContext();
  if (!ctx) throw new ForbiddenError("Not signed in");
  if (ctx.isSuperAdmin || !ctx.companyId) throw new ForbiddenError("Not a company user");
  if (!can(ctx, key, minScope)) throw new ForbiddenError();
  return ctx as TenantCtx;
}

export async function assertSuperAdmin(): Promise<Ctx> {
  const ctx = await getContext();
  if (!ctx?.isSuperAdmin) throw new ForbiddenError("Platform administrators only");
  return ctx;
}
