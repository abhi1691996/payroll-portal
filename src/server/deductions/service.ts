import type { TenantDb } from "@/server/tenancy/db";
import { can, type TenantCtx } from "@/server/rbac/context";
import { audit } from "@/server/audit/audit";
import { getPeriodLocks } from "@/server/payroll/locks";

/**
 * One-off deductions outside loans and the statutory ones (uniform cost, damage recovery, ...): an admin
 * adds them for a specific employee and period before running payroll; see the OTHER_DEDUCTIONS stage in
 * src/server/payroll/locks.ts. Applied automatically by processPayrollRun for as long as they exist.
 */

async function assertEditable(db: TenantDb, month: number, year: number) {
  const run = await db.payrollRun.findFirst({ where: { month, year }, select: { status: true } });
  if (run?.status === "FINALIZED") throw new Error("This period is marked as paid and can no longer be changed");
  const locks = await getPeriodLocks(db, month, year);
  if (locks.otherDeductions) throw new Error("Other deductions are locked for this period — unlock that stage first");
}

export interface AdHocDeductionRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  name: string;
  amount: number;
  note: string | null;
}

export async function adHocDeductionsFor(db: TenantDb, month: number, year: number): Promise<AdHocDeductionRow[]> {
  const rows = await db.adHocDeduction.findMany({
    where: { month, year },
    include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employeeId,
    employeeCode: r.employee.employeeCode,
    employeeName: `${r.employee.firstName} ${r.employee.lastName}`.trim(),
    name: r.name,
    amount: Number(r.amount),
    note: r.note,
  }));
}

export interface AddAdHocDeductionInput {
  employeeId: string;
  month: number;
  year: number;
  name: string;
  amount: number;
  note?: string | null;
}

export async function addAdHocDeduction(db: TenantDb, ctx: TenantCtx, input: AddAdHocDeductionInput) {
  if (!can(ctx, "payroll.run", "COMPANY")) throw new Error("You don't have permission to add payroll deductions");
  if (!input.name.trim()) throw new Error("A description is required");
  if (!(input.amount > 0)) throw new Error("Amount must be greater than 0");
  await assertEditable(db, input.month, input.year);

  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true } });
  if (!employee) throw new Error("Employee not found");

  const created = await db.adHocDeduction.create({
    data: {
      companyId: ctx.companyId, employeeId: input.employeeId, month: input.month, year: input.year,
      code: input.name.trim().toUpperCase().replace(/\s+/g, "_").slice(0, 20),
      name: input.name.trim(), amount: input.amount, note: input.note || null,
      createdByUserId: ctx.userId,
    },
  });
  await audit(db, ctx, {
    module: "payroll", action: "deduction.add", entityType: "AdHocDeduction", entityId: created.id,
    newValue: { employeeCode: employee.employeeCode, month: input.month, year: input.year, name: input.name, amount: input.amount },
  });
  return created;
}

export async function removeAdHocDeduction(db: TenantDb, ctx: TenantCtx, id: string) {
  if (!can(ctx, "payroll.run", "COMPANY")) throw new Error("You don't have permission to remove payroll deductions");
  const row = await db.adHocDeduction.findUnique({ where: { id } });
  if (!row) throw new Error("Deduction not found");
  await assertEditable(db, row.month, row.year);

  await db.adHocDeduction.delete({ where: { id } });
  await audit(db, ctx, { module: "payroll", action: "deduction.remove", entityType: "AdHocDeduction", entityId: id, oldValue: { month: row.month, year: row.year, name: row.name, amount: Number(row.amount) } });
}
