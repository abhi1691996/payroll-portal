import { Prisma } from "@prisma/client";
import { basePrisma } from "./base-client";

/**
 * Tenant isolation, layer 1 of 3:
 *   1. THIS FILE — a Prisma client extension that forces `companyId = <tenant>` into every query on
 *      a tenant table, and stamps it on every insert. Callers cannot opt out or target another tenant.
 *   2. Composite foreign keys in schema.prisma — a row cannot reference another company's record.
 *   3. Postgres Row-Level Security (rls migration) — refuses cross-tenant rows even if 1 has a bug.
 *
 * Every unit of work runs in ONE transaction that first sets `app.tenant_id`, which RLS reads.
 */

/** Models whose rows belong to a tenant and are filtered by `companyId`. */
const TENANT_MODELS = new Set([
  "Subscription",
  "StatutoryConfig",
  "User",
  "Role",
  "RolePermission",
  "UserRole",
  "Invitation",
  "SupportSession",
  "AuditLog",
  "Employee",
  "EmployeeSuspension",
  "EmployeeSeparation",
  "EmployeeLoan",
  "LoanInstallment",
  "AttendanceRecord",
  "LeaveType",
  "LeaveRequest",
  "PayrollRun",
  "Payslip",
  // Salary set-up
  "SalaryComponent",
  "SalaryTemplate",
  "SalaryTemplateLine",
  "EmployeeSalary",
  // Attendance & shifts
  "Shift",
  "Holiday",
  "AttendanceRule",
  "CompanySetting",
  // Leave engine
  "LeavePolicy",
  "LeavePolicyRule",
  "LeaveLedger",
  // Approvals
  "ApprovalWorkflow",
  "ApprovalLevel",
  "ApprovalRequest",
  "ApprovalAction",
]);

/** Filtered by `id` instead of `companyId`. A tenant may read/update its own row, never create/delete. */
const COMPANY_MODEL = "Company";

/** Platform-owned tables: a tenant may read them but never write. */
const PLATFORM_READ_ONLY = new Set(["Plan", "Permission"]);

const UNIQUE_OR_FILTER_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

export class TenantIsolationError extends Error {}

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: unknown;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

function assertNoTenantWrite(data: unknown, key: string, model: string) {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (row && typeof row === "object" && key in (row as object)) {
      throw new TenantIsolationError(`${model}: ${key} cannot be changed through the tenant client`);
    }
  }
}

function scopeExtension(companyId: string) {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (PLATFORM_READ_ONLY.has(model)) {
            if (!operation.startsWith("find") && operation !== "count" && operation !== "aggregate" && operation !== "groupBy") {
              throw new TenantIsolationError(`${model} is platform-owned; tenants cannot modify it`);
            }
            return query(args);
          }

          if (model === COMPANY_MODEL) {
            if (operation === "create" || operation === "createMany" || operation === "delete" || operation === "deleteMany" || operation === "upsert") {
              throw new TenantIsolationError("Companies are managed from the platform portal");
            }
            const a = (args ?? {}) as AnyArgs;
            // AND the tenant condition instead of overwriting `id`: a caller asking for another
            // company's id must get "not found", never a silently retargeted write to their own row.
            const existingAnd = a.where?.AND;
            const and = Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : [];
            a.where = { ...(a.where ?? {}), AND: [...and, { id: companyId }] };
            return query(a as typeof args);
          }

          if (!TENANT_MODELS.has(model)) {
            throw new TenantIsolationError(`${model} is not registered with the tenant client`);
          }

          const a = (args ?? {}) as AnyArgs;

          if (UNIQUE_OR_FILTER_OPS.has(operation)) {
            // Spread (not AND-wrap) so findUnique/update/delete keep a valid unique `where`.
            // The tenant key is applied LAST, so a caller-supplied companyId is overridden.
            a.where = { ...(a.where ?? {}), companyId };
            if (operation === "update" || operation === "updateMany") assertNoTenantWrite(a.data, "companyId", model);
            return query(a as typeof args);
          }

          switch (operation) {
            case "create": {
              a.data = { ...(a.data as object), companyId };
              return query(a as typeof args);
            }
            case "createMany":
            case "createManyAndReturn": {
              const rows = Array.isArray(a.data) ? a.data : [a.data];
              a.data = rows.map((r) => ({ ...(r as object), companyId }));
              return query(a as typeof args);
            }
            case "upsert": {
              a.where = { ...(a.where ?? {}), companyId };
              a.create = { ...(a.create ?? {}), companyId };
              assertNoTenantWrite(a.update, "companyId", model);
              return query(a as typeof args);
            }
            default:
              throw new TenantIsolationError(`Unsupported operation on ${model}: ${operation}`);
          }
        },
      },
    },
  });
}

/** Builds a scoped client type without needing a real tenant (used only for typing). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function typedClient() {
  return basePrisma.$extends(scopeExtension("type-only"));
}

type ExtendedClient = ReturnType<typeof typedClient>;

/** The client handed to tenant code: all model access is scoped; transactions are already open. */
export type TenantDb = Omit<
  ExtendedClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

/** Raw transaction client — no scoping. Only for trusted platform code (login, Super Admin). */
export type PlatformDb = Prisma.TransactionClient;

interface TxOptions {
  /** Milliseconds. Bulk imports need longer than the 15s default. */
  timeout?: number;
}

/**
 * Runs `fn` as ONE transaction scoped to a single company. Nothing inside can read or write another
 * company's rows. Throw to roll everything back.
 */
export async function withTenant<T>(
  companyId: string,
  fn: (db: TenantDb) => Promise<T>,
  options: TxOptions = {}
): Promise<T> {
  if (!companyId) throw new TenantIsolationError("withTenant requires a companyId");
  const client = basePrisma.$extends(scopeExtension(companyId));
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${companyId}, true)`;
      return fn(tx as unknown as TenantDb);
    },
    { timeout: options.timeout ?? 15_000, maxWait: 5_000 }
  );
}

/**
 * Runs `fn` with platform privileges (sees every company). Reserved for: authentication lookups,
 * Super Admin screens, and company provisioning. Never call this on behalf of a tenant user.
 */
export async function withPlatform<T>(
  fn: (db: PlatformDb) => Promise<T>,
  options: TxOptions = {}
): Promise<T> {
  return basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform', 'on', true)`;
      return fn(tx);
    },
    { timeout: options.timeout ?? 15_000, maxWait: 5_000 }
  );
}
