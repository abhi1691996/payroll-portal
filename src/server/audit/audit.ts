import type { Prisma } from "@prisma/client";
import type { Ctx } from "@/server/rbac/context";
import type { PlatformDb, TenantDb } from "@/server/tenancy/db";

export interface AuditEvent {
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

const REDACT = new Set(["passwordHash", "tokenHash", "password", "tempPassword"]);

/** JSON-safe copy (Dates/Decimals become strings) with secrets removed. */
function clean(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, v) => (REDACT.has(key) ? "[redacted]" : v))
  ) as Prisma.InputJsonValue;
}

/**
 * Records an audit event. Call it INSIDE the same transaction as the change it describes
 * (`withTenant`/`withPlatform` callback), so a change can never commit without its audit row.
 * The table is append-only at the database level.
 */
export async function audit(
  db: TenantDb | PlatformDb,
  ctx: Pick<Ctx, "userId" | "email" | "companyId" | "ip" | "userAgent">,
  event: AuditEvent
): Promise<void> {
  await (db as PlatformDb).auditLog.create({
    data: {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      actorEmail: ctx.email,
      module: event.module,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      oldValue: clean(event.oldValue),
      newValue: clean(event.newValue),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    },
  });
}
