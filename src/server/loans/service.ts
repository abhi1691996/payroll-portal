import type { LoanType } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { can, type TenantCtx } from "@/server/rbac/context";
import { audit } from "@/server/audit/audit";

/**
 * Loans and salary advances. An employee applies (amount + tenure); an admin (`loan.manage`) approves or
 * rejects — one step, no reporting-manager level, unlike leave/resignation. Once approved, nothing is
 * deducted automatically: processing a payroll run is where an admin explicitly picks which outstanding
 * loans get a deduction this period (see `eligibleLoansFor` and `payroll/runs/actions.ts`), which is what
 * actually reduces `outstandingBalance` and records a `LoanInstallment`.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Rounds UP to the paisa, so tenureMonths x installment is never less than the principal — the last
 * installment (via `min(installment, outstandingBalance)` in applyLoanDeductions) then always comes out
 * a little smaller instead of leaving a stray remainder that needs an extra period to clear. */
const roundUp2 = (n: number) => Math.ceil(n * 100) / 100;
const today = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};

export interface ApplyLoanInput {
  employeeId: string;
  type: LoanType;
  principalAmount: number;
  tenureMonths: number;
  reason?: string | null;
}

export async function applyForLoan(db: TenantDb, ctx: TenantCtx, input: ApplyLoanInput): Promise<{ loanId: string }> {
  if (!(input.principalAmount > 0)) throw new Error("Amount must be greater than 0");
  if (!Number.isInteger(input.tenureMonths) || input.tenureMonths < 1) throw new Error("Tenure must be at least 1 month");

  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true, status: true } });
  if (!employee) throw new Error("Employee not found");
  if (employee.status === "RESIGNED" || employee.status === "TERMINATED") throw new Error("This employee has already left the company");

  const monthlyInstallment = roundUp2(input.principalAmount / input.tenureMonths);
  const loan = await db.employeeLoan.create({
    data: {
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      type: input.type,
      status: "PENDING",
      principalAmount: input.principalAmount,
      tenureMonths: input.tenureMonths,
      monthlyInstallment,
      outstandingBalance: input.principalAmount,
      reason: input.reason || null,
      appliedDate: today(),
      requestedByUserId: ctx.userId,
    },
  });
  await audit(db, ctx, {
    module: "loans", action: "loan.apply", entityType: "EmployeeLoan", entityId: loan.id,
    newValue: { employeeCode: employee.employeeCode, type: input.type, principalAmount: input.principalAmount, tenureMonths: input.tenureMonths },
  });
  return { loanId: loan.id };
}

/** Approve or reject — a direct admin decision, not the generic (reporting-manager) approval engine. */
export async function decideLoan(db: TenantDb, ctx: TenantCtx, input: { loanId: string; action: "APPROVE" | "REJECT"; comment?: string }): Promise<void> {
  if (!can(ctx, "loan.manage", "COMPANY")) throw new Error("You don't have permission to decide loan requests");
  const loan = await db.employeeLoan.findUnique({ where: { id: input.loanId } });
  if (!loan) throw new Error("Loan not found");
  if (loan.status !== "PENDING") throw new Error("This request has already been decided");
  if (loan.employeeId === ctx.employeeId) throw new Error("You can't decide your own loan request");

  await db.employeeLoan.update({
    where: { id: loan.id },
    data: { status: input.action === "APPROVE" ? "APPROVED" : "REJECTED", decidedByUserId: ctx.userId, decidedAt: new Date() },
  });
  await audit(db, ctx, {
    module: "loans", action: input.action === "APPROVE" ? "loan.approve" : "loan.reject", entityType: "EmployeeLoan", entityId: loan.id,
    newValue: { comment: input.comment || null },
  });
}

/** The employee (while pending) or an admin can call it off before it's decided. */
export async function withdrawLoan(db: TenantDb, ctx: TenantCtx, loanId: string): Promise<void> {
  const loan = await db.employeeLoan.findUnique({ where: { id: loanId } });
  if (!loan) throw new Error("Loan not found");
  if (loan.status !== "PENDING") throw new Error("Only a pending request can be withdrawn");
  const isSelf = !!ctx.employeeId && ctx.employeeId === loan.employeeId;
  if (!isSelf && !can(ctx, "loan.manage", "COMPANY")) throw new Error("You can't withdraw this request");

  await db.employeeLoan.update({ where: { id: loan.id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedByUserId: ctx.userId } });
  await audit(db, ctx, { module: "loans", action: "loan.withdraw", entityType: "EmployeeLoan", entityId: loan.id });
}

export interface EligibleLoan {
  id: string;
  type: LoanType;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  outstandingBalance: number;
  /** What this period would deduct if selected: the installment, or whatever's left if less. */
  plannedAmount: number;
}

/**
 * Approved loans still owing money, that haven't already had a deduction recorded for this exact period
 * (so re-opening the run after a "close the deductions" pass doesn't offer the same loan twice), for
 * employees still on the active roster. This is what the payroll run page offers as checkboxes.
 */
export async function eligibleLoansFor(db: TenantDb, companyId: string, month: number, year: number): Promise<EligibleLoan[]> {
  const loans = await db.employeeLoan.findMany({
    where: { companyId, status: "APPROVED", outstandingBalance: { gt: 0 } },
    include: {
      employee: { select: { employeeCode: true, firstName: true, lastName: true, status: true } },
      installments: { where: { month, year }, select: { id: true } },
    },
    orderBy: { appliedDate: "asc" },
  });
  return loans
    .filter((l) => l.installments.length === 0 && l.employee.status !== "RESIGNED" && l.employee.status !== "TERMINATED")
    .map((l) => ({
      id: l.id,
      type: l.type,
      employeeId: l.employeeId,
      employeeCode: l.employee.employeeCode,
      employeeName: `${l.employee.firstName} ${l.employee.lastName}`.trim(),
      outstandingBalance: Number(l.outstandingBalance),
      plannedAmount: Math.min(Number(l.monthlyInstallment), Number(l.outstandingBalance)),
    }));
}

/**
 * Deducts the planned amount for each of the given loan ids against this payroll run: records the
 * `LoanInstallment`, reduces `outstandingBalance`, and closes the loan once it reaches zero. Returns the
 * amount deducted per employee id, so the caller can subtract it from that employee's net pay. Call once
 * per run, inside the same transaction as everything else `processPayrollRun` does.
 */
export async function applyLoanDeductions(
  db: TenantDb,
  companyId: string,
  payrollRunId: string,
  month: number,
  year: number,
  loanIds: string[]
): Promise<Map<string, { employeeId: string; deductionLines: { code: string; name: string; amount: number }[] }>> {
  const byEmployee = new Map<string, { employeeId: string; deductionLines: { code: string; name: string; amount: number }[] }>();
  if (loanIds.length === 0) return byEmployee;

  const eligible = await eligibleLoansFor(db, companyId, month, year);
  const selected = eligible.filter((l) => loanIds.includes(l.id));

  for (const l of selected) {
    if (!(l.plannedAmount > 0)) continue;
    await db.loanInstallment.create({
      data: { companyId, loanId: l.id, payrollRunId, month, year, amount: l.plannedAmount },
    });
    const newBalance = round2(l.outstandingBalance - l.plannedAmount);
    await db.employeeLoan.update({
      where: { id: l.id },
      data: { outstandingBalance: newBalance, ...(newBalance <= 0 ? { status: "CLOSED" as const } : {}) },
    });
    const entry = byEmployee.get(l.employeeId) ?? { employeeId: l.employeeId, deductionLines: [] };
    entry.deductionLines.push({
      code: l.type === "LOAN" ? "LOAN_REPAY" : "ADVANCE_REPAY",
      name: l.type === "LOAN" ? "Loan repayment" : "Advance repayment",
      amount: l.plannedAmount,
    });
    byEmployee.set(l.employeeId, entry);
  }
  return byEmployee;
}
