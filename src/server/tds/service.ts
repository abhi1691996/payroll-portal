import type { TaxRegime } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { can, type TenantCtx } from "@/server/rbac/context";
import { audit } from "@/server/audit/audit";
import { fyMonths } from "@/lib/fy";
import { computeTdsComputation, type TdsDeductionLine } from "@/lib/payroll-calculations";
import { getStatutoryConfigFor } from "@/lib/statutory-config";

/**
 * Employee-wise TDS computation: a versioned, approved figure payroll deducts from instead of estimating
 * TDS itself from the current month's pay. See prisma schema `TdsComputation` for the field-by-field
 * meaning; this file is the only place that writes those rows.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export function defaultDeductionLines(taxRegime: TaxRegime): TdsDeductionLine[] {
  // FY2025-26+ figures. The company's own statutory config doesn't carry a standard-deduction setting
  // (see docs/architecture.md) — these are just a sensible starting point; the admin can edit every line.
  return taxRegime === "NEW"
    ? [{ code: "STD_DED", name: "Standard Deduction", amount: 75000 }]
    : [{ code: "STD_DED", name: "Standard Deduction", amount: 50000 }];
}

/** The PayrollRun rows (id + period) that fall inside this financial year and already have payslips. */
async function fyPayslips(db: TenantDb, employeeId: string, financialYear: number) {
  const months = fyMonths(financialYear);
  const runs = await db.payrollRun.findMany({
    where: { OR: months.map((m) => ({ year: m.year, month: m.month })) },
    select: { id: true, year: true, month: true },
  });
  if (runs.length === 0) return [];
  const payslips = await db.payslip.findMany({
    where: { employeeId, payrollRunId: { in: runs.map((r) => r.id) } },
    select: { grossPay: true, breakdown: true, payrollRunId: true },
  });
  const runById = new Map(runs.map((r) => [r.id, r]));
  return payslips.map((p) => ({ ...p, run: runById.get(p.payrollRunId)! }));
}

/** Actual gross pay already paid this FY, plus the remaining FY months projected at the employee's current salary. */
export async function projectAnnualGrossIncome(db: TenantDb, employeeId: string, financialYear: number): Promise<number> {
  const paid = await fyPayslips(db, employeeId, financialYear);
  const paidKeys = new Set(paid.map((p) => `${p.run.year}-${p.run.month}`));
  const actual = paid.reduce((s, p) => s + Number(p.grossPay), 0);

  let projected = 0;
  for (const m of fyMonths(financialYear)) {
    if (paidKeys.has(`${m.year}-${m.month}`)) continue;
    const periodEnd = new Date(Date.UTC(m.year, m.month, 1));
    const salary = await db.employeeSalary.findFirst({
      where: { employeeId, effectiveFrom: { lt: periodEnd } },
      orderBy: { effectiveFrom: "desc" },
      select: { grossMonthly: true },
    });
    if (salary) projected += Number(salary.grossMonthly);
  }
  return round2(actual + projected);
}

/** TDS already withheld this FY (from processed payslips) and how many FY months are left unpaid. */
export async function tdsDeductedSoFar(db: TenantDb, employeeId: string, financialYear: number): Promise<{ amount: number; remainingMonths: number }> {
  const paid = await fyPayslips(db, employeeId, financialYear);
  const amount = round2(
    paid.reduce((s, p) => {
      const breakdown = p.breakdown as unknown as { employeeDeductions?: { tds?: number } };
      return s + (Number(breakdown?.employeeDeductions?.tds) || 0);
    }, 0)
  );
  return { amount, remainingMonths: Math.max(0, 12 - paid.length) };
}

export interface TdsPreview {
  grossIncome: number;
  deductionLines: TdsDeductionLine[];
  tdsAlreadyDeducted: number;
  remainingMonths: number;
  totalDeductions: number;
  taxableIncome: number;
  taxLiability: number;
  rebate87A: number;
  cess: number;
  annualTdsLiability: number;
  balanceTds: number;
  monthlyTds: number;
}

/** Runs the computation without saving anything — powers the live preview on the compute screen. */
export async function previewTdsComputation(
  db: TenantDb,
  input: { employeeId: string; financialYear: number; taxRegime: TaxRegime; grossIncome?: number; deductionLines?: TdsDeductionLine[] }
): Promise<TdsPreview> {
  const grossIncome = input.grossIncome ?? (await projectAnnualGrossIncome(db, input.employeeId, input.financialYear));
  const deductionLines = input.deductionLines ?? defaultDeductionLines(input.taxRegime);
  const { amount: tdsAlreadyDeducted, remainingMonths } = await tdsDeductedSoFar(db, input.employeeId, input.financialYear);
  const config = await getStatutoryConfigFor(db, new Date());
  const result = computeTdsComputation({ grossIncome, deductionLines, tdsAlreadyDeducted, remainingMonths, slabs: config.incomeTaxSlabs[input.taxRegime], taxRegime: input.taxRegime });
  return { grossIncome, deductionLines, tdsAlreadyDeducted, remainingMonths, ...result };
}

export interface SaveTdsComputationInput {
  employeeId: string;
  financialYear: number;
  taxRegime: TaxRegime;
  grossIncome: number;
  deductionLines: TdsDeductionLine[];
  revisionReason?: string | null;
}

/** Saves a new version as a DRAFT — snapshotting "already deducted" and "remaining months" as of right now. */
export async function createTdsComputation(db: TenantDb, ctx: TenantCtx, input: SaveTdsComputationInput) {
  if (!can(ctx, "tds.manage", "COMPANY")) throw new Error("You don't have permission to compute TDS");
  if (!(input.grossIncome >= 0)) throw new Error("Gross income can't be negative");
  for (const l of input.deductionLines) {
    if (!(l.amount >= 0)) throw new Error(`${l.name || "A deduction line"} can't be negative`);
  }

  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true } });
  if (!employee) throw new Error("Employee not found");

  const latest = await db.tdsComputation.findFirst({
    where: { employeeId: input.employeeId, financialYear: input.financialYear },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;
  if (version > 1 && !input.revisionReason?.trim()) throw new Error("A reason is required when revising an existing computation");

  const { amount: tdsAlreadyDeducted, remainingMonths } = await tdsDeductedSoFar(db, input.employeeId, input.financialYear);
  const config = await getStatutoryConfigFor(db, new Date());
  const result = computeTdsComputation({
    grossIncome: input.grossIncome, deductionLines: input.deductionLines, tdsAlreadyDeducted, remainingMonths,
    slabs: config.incomeTaxSlabs[input.taxRegime], taxRegime: input.taxRegime,
  });

  const created = await db.tdsComputation.create({
    data: {
      companyId: ctx.companyId, employeeId: input.employeeId, financialYear: input.financialYear, version, status: "DRAFT",
      taxRegime: input.taxRegime, revisionReason: input.revisionReason || null,
      grossIncome: input.grossIncome, deductionLines: input.deductionLines,
      totalDeductions: result.totalDeductions, taxableIncome: result.taxableIncome, taxLiability: result.taxLiability,
      rebate87A: result.rebate87A, cess: result.cess,
      annualTdsLiability: result.annualTdsLiability, tdsAlreadyDeducted, balanceTds: result.balanceTds,
      remainingMonths, monthlyTds: result.monthlyTds, requestedByUserId: ctx.userId,
    },
  });
  await audit(db, ctx, {
    module: "tds", action: "tds.compute", entityType: "TdsComputation", entityId: created.id,
    newValue: { employeeCode: employee.employeeCode, financialYear: input.financialYear, version, annualTdsLiability: result.annualTdsLiability, monthlyTds: result.monthlyTds },
  });
  return created;
}

/** Approves a DRAFT: it becomes what payroll uses, and the previously-APPROVED version (if any) is superseded. */
export async function approveTdsComputation(db: TenantDb, ctx: TenantCtx, computationId: string) {
  if (!can(ctx, "tds.manage", "COMPANY")) throw new Error("You don't have permission to approve TDS computations");
  const comp = await db.tdsComputation.findUnique({ where: { id: computationId } });
  if (!comp) throw new Error("Computation not found");
  if (comp.status !== "DRAFT") throw new Error("Only a draft can be approved");

  await db.tdsComputation.updateMany({
    where: { employeeId: comp.employeeId, financialYear: comp.financialYear, status: "APPROVED" },
    data: { status: "SUPERSEDED" },
  });
  const approved = await db.tdsComputation.update({
    where: { id: comp.id },
    data: { status: "APPROVED", approvedByUserId: ctx.userId, approvedAt: new Date() },
  });
  await audit(db, ctx, {
    module: "tds", action: "tds.approve", entityType: "TdsComputation", entityId: comp.id,
    newValue: { financialYear: comp.financialYear, version: comp.version, monthlyTds: Number(comp.monthlyTds) },
  });
  return approved;
}

/** Computes a new version and approves it in the same step — the common case when one person does both. */
export async function createAndApproveTdsComputation(db: TenantDb, ctx: TenantCtx, input: SaveTdsComputationInput) {
  const created = await createTdsComputation(db, ctx, input);
  return approveTdsComputation(db, ctx, created.id);
}

/** Discards a draft that wasn't approved — kept (as WITHDRAWN) for the audit trail, not deleted. */
export async function withdrawTdsComputation(db: TenantDb, ctx: TenantCtx, computationId: string) {
  if (!can(ctx, "tds.manage", "COMPANY")) throw new Error("You don't have permission to withdraw TDS computations");
  const comp = await db.tdsComputation.findUnique({ where: { id: computationId } });
  if (!comp) throw new Error("Computation not found");
  if (comp.status !== "DRAFT") throw new Error("Only a draft can be withdrawn");

  await db.tdsComputation.update({ where: { id: comp.id }, data: { status: "WITHDRAWN" } });
  await audit(db, ctx, { module: "tds", action: "tds.withdraw", entityType: "TdsComputation", entityId: comp.id });
}

/** What payroll actually uses: the latest APPROVED version for this employee and financial year, if any. */
export async function latestApprovedTds(db: TenantDb, employeeId: string, financialYear: number) {
  return db.tdsComputation.findFirst({
    where: { employeeId, financialYear, status: "APPROVED" },
    orderBy: { version: "desc" },
  });
}
