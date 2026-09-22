import type { TenantDb } from "@/server/tenancy/db";
import type { TenantCtx } from "@/server/rbac/context";
import { audit } from "@/server/audit/audit";

export interface NewEmployeeInput {
  employeeCode: string;
  firstName: string;
  lastName: string;
  /** Login email. */
  email: string;
  personalEmail?: string | null;
  phone?: string | null;
  panNumber?: string | null;
  aadhaarLast4?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  department?: string | null;
  designation?: string | null;
  dateOfJoining: Date;
  state: string;
  taxRegime?: "OLD" | "NEW";
  passwordHash: string;
}

/**
 * Creates an employee together with their portal login and the EMPLOYEE role, and audits it.
 * Runs inside the caller's tenant transaction.
 */
export async function createEmployeeWithLogin(
  db: TenantDb,
  ctx: TenantCtx,
  input: NewEmployeeInput
): Promise<{ employeeId: string; userId: string }> {
  const employeeRole = await db.role.findFirst({ where: { key: "EMPLOYEE" } });
  if (!employeeRole) throw new Error("This company has no EMPLOYEE role — it was not provisioned correctly");

  // `companyId` on the user is stamped by the tenant client. Nested writes are NOT, so they carry it
  // explicitly (the composite foreign keys and RLS would reject a mismatch anyway).
  const user = await db.user.create({
    data: {
      email: input.email.trim().toLowerCase(),
      name: `${input.firstName} ${input.lastName}`,
      passwordHash: input.passwordHash,
      status: "ACTIVE",
      userRoles: { create: { roleId: employeeRole.id, companyId: ctx.companyId } },
      employee: {
        create: {
          companyId: ctx.companyId,
          employeeCode: input.employeeCode,
          firstName: input.firstName,
          lastName: input.lastName,
          personalEmail: input.personalEmail || null,
          phone: input.phone || null,
          panNumber: input.panNumber || null,
          aadhaarLast4: input.aadhaarLast4 || null,
          bankAccountNumber: input.bankAccountNumber || null,
          bankIfsc: input.bankIfsc || null,
          department: input.department || null,
          designation: input.designation || null,
          dateOfJoining: input.dateOfJoining,
          state: input.state,
          taxRegime: input.taxRegime ?? "NEW",
        },
      },
    },
    include: { employee: { select: { id: true } } },
  });

  await audit(db, ctx, {
    module: "employees",
    action: "employee.create",
    entityType: "Employee",
    entityId: user.employee!.id,
    newValue: {
      employeeCode: input.employeeCode,
      name: `${input.firstName} ${input.lastName}`,
      email: user.email,
      department: input.department,
      dateOfJoining: input.dateOfJoining,
      taxRegime: input.taxRegime ?? "NEW",
    },
  });

  return { employeeId: user.employee!.id, userId: user.id };
}

/**
 * The next code in the company's numbering, e.g. prefix "EMP" -> EMP001, EMP002 ... Only codes of the
 * form <prefix><digits> are considered, so hand-typed codes in other formats never collide.
 */
export async function nextEmployeeCode(db: TenantDb, prefix: string): Promise<string> {
  const rows = await db.employee.findMany({ where: { employeeCode: { startsWith: prefix } }, select: { employeeCode: true } });
  let max = 0;
  let width = 3;
  for (const { employeeCode } of rows) {
    const rest = employeeCode.slice(prefix.length);
    if (/^\d+$/.test(rest)) {
      max = Math.max(max, Number(rest));
      width = Math.max(width, rest.length);
    }
  }
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}
