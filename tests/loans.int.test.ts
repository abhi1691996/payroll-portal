import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { createEmployeeWithLogin } from "@/server/employees/service";
import { mergeGrants, type TenantCtx } from "@/server/rbac/context";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import { applyForLoan, applyLoanDeductions, decideLoan, eligibleLoansFor, withdrawLoan } from "@/server/loans/service";

const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

function ctxOf(companyId: string, user: { id: string; email: string }, employeeId: string | null, roles: string[]): TenantCtx {
  const grants = roles.flatMap((r) =>
    Object.entries(SYSTEM_ROLES.find((x) => x.key === r)!.grants).map(([permissionKey, scope]) => ({ permissionKey, scope: scope! }))
  );
  return { userId: user.id, email: user.email, name: user.email, companyId, isSuperAdmin: false, employeeId, roleKeys: roles, permissions: mergeGrants(grants), ip: null, userAgent: null };
}

interface World {
  companyId: string;
  admin: TenantCtx;
  payroll: TenantCtx;
  employee: TenantCtx;
  ids: { employee: string; manager: string };
}

async function makeWorld(tag: string): Promise<World> {
  const { companyId, roleIds, adminUserId } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name: `Loans ${tag}`, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: "Admin", email: `admin@loans-${tag}.test`, password: "Password@123" },
    })
  );
  const mk = async (email: string, code: string, roles: string[]) => {
    const user = await owner.user.create({
      data: {
        companyId, email, passwordHash: "x", name: email,
        userRoles: { create: roles.map((r) => ({ roleId: roleIds.get(r)!, companyId })) },
        employee: { create: { companyId, employeeCode: code, firstName: code, lastName: "Person", state: "Karnataka", dateOfJoining: new Date("2023-01-01") } },
      },
      include: { employee: true },
    });
    return { user, employeeId: user.employee!.id };
  };
  const e = await mk(`emp@loans-${tag}.test`, "E1", ["EMPLOYEE"]);
  const p = await owner.user.create({
    data: { companyId, email: `payroll@loans-${tag}.test`, passwordHash: "x", name: "Payroll", userRoles: { create: { roleId: roleIds.get("PAYROLL_MANAGER")!, companyId } } },
  });
  return {
    companyId,
    admin: ctxOf(companyId, { id: adminUserId, email: `admin@loans-${tag}.test` }, null, ["COMPANY_ADMIN"]),
    payroll: ctxOf(companyId, p, null, ["PAYROLL_MANAGER"]),
    employee: ctxOf(companyId, e.user, e.employeeId, ["EMPLOYEE"]),
    ids: { employee: e.employeeId, manager: "" },
  };
}

let A: World;

beforeAll(async () => { A = await makeWorld("alpha"); });
afterAll(async () => { await owner.$disconnect(); await basePrisma.$disconnect(); });

describe("applying and deciding", () => {
  it("computes the monthly installment and starts pending", async () => {
    const { loanId } = await withTenant(A.companyId, (db) =>
      applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "LOAN", principalAmount: 12000, tenureMonths: 4, reason: "Medical" })
    );
    const loan = await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe("PENDING");
    expect(Number(loan.monthlyInstallment)).toBe(3000);
    expect(Number(loan.outstandingBalance)).toBe(12000);
  });

  it("rejects a non-positive amount and a fractional tenure", async () => {
    await expect(
      withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "ADVANCE", principalAmount: 0, tenureMonths: 1 }))
    ).rejects.toThrow(/greater than 0/);
    await expect(
      withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "ADVANCE", principalAmount: 1000, tenureMonths: 0 }))
    ).rejects.toThrow(/at least 1 month/);
  });

  it("the employee can't decide their own request; a non-manager permission holder can", async () => {
    const { loanId } = await withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "ADVANCE", principalAmount: 5000, tenureMonths: 1 }));
    await expect(withTenant(A.companyId, (db) => decideLoan(db, A.employee, { loanId, action: "APPROVE" }))).rejects.toThrow(/permission/);

    // Approve via the Payroll Manager, who holds loan.manage but never applied it themselves.
    await withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId, action: "APPROVE" }));
    const loan = await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe("APPROVED");
    expect(Number(loan.outstandingBalance)).toBe(5000);

    // Can't decide an already-decided request again.
    await expect(withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId, action: "REJECT" }))).rejects.toThrow(/already been decided/);
  });

  it("rejecting leaves nothing owed, and a pending request can be withdrawn", async () => {
    const rejected = await withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "LOAN", principalAmount: 2000, tenureMonths: 2 }));
    await withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId: rejected.loanId, action: "REJECT" }));
    expect((await owner.employeeLoan.findUniqueOrThrow({ where: { id: rejected.loanId } })).status).toBe("REJECTED");

    const withdrawn = await withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "LOAN", principalAmount: 2000, tenureMonths: 2 }));
    await withTenant(A.companyId, (db) => withdrawLoan(db, A.employee, withdrawn.loanId));
    expect((await owner.employeeLoan.findUniqueOrThrow({ where: { id: withdrawn.loanId } })).status).toBe("WITHDRAWN");
    await expect(withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId: withdrawn.loanId, action: "APPROVE" }))).rejects.toThrow(/already been decided/);
  });
});

describe("payroll deductions", () => {
  it("closing a deduction reduces the balance, records the ledger, and skips it next time it's already closed", async () => {
    const { loanId } = await withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "LOAN", principalAmount: 9000, tenureMonths: 3 }));
    await withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId, action: "APPROVE" }));

    const run = await owner.payrollRun.create({ data: { companyId: A.companyId, month: 1, year: 2027, createdById: A.admin.userId, status: "PROCESSED" } });

    const before = await withTenant(A.companyId, (db) => eligibleLoansFor(db, A.companyId, 1, 2027));
    expect(before.map((l) => l.id)).toContain(loanId);
    expect(before.find((l) => l.id === loanId)?.plannedAmount).toBe(3000);

    const applied = await withTenant(A.companyId, (db) => applyLoanDeductions(db, A.companyId, run.id, 1, 2027, [loanId]));
    expect(applied.get(A.ids.employee)?.deductionLines).toEqual([{ code: "LOAN_REPAY", name: "Loan repayment", amount: 3000 }]);

    const loan = await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } });
    expect(Number(loan.outstandingBalance)).toBe(6000);
    expect(loan.status).toBe("APPROVED"); // still owes money

    // The same period is no longer offered, and re-applying it is a silent no-op (idempotent re-processing).
    const after = await withTenant(A.companyId, (db) => eligibleLoansFor(db, A.companyId, 1, 2027));
    expect(after.map((l) => l.id)).not.toContain(loanId);
    const reapplied = await withTenant(A.companyId, (db) => applyLoanDeductions(db, A.companyId, run.id, 1, 2027, [loanId]));
    expect(reapplied.size).toBe(0);
    expect(Number((await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } })).outstandingBalance)).toBe(6000);

    // A different period is offered again.
    const feb = await withTenant(A.companyId, (db) => eligibleLoansFor(db, A.companyId, 2, 2027));
    expect(feb.map((l) => l.id)).toContain(loanId);
  });

  it("skipping a period leaves the full amount owed, and the last installment absorbs any rounding remainder", async () => {
    const { loanId } = await withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "ADVANCE", principalAmount: 1000, tenureMonths: 3 }));
    await withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId, action: "APPROVE" }));
    // 1000 / 3 rounds UP to 333.34/mo, so 3 installments cover the full 1000 (the last one a touch smaller)
    // instead of leaving a stray paisa that would need a 4th period to clear.
    expect(Number((await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } })).monthlyInstallment)).toBe(333.34);

    const run1 = await owner.payrollRun.create({ data: { companyId: A.companyId, month: 3, year: 2027, createdById: A.admin.userId, status: "PROCESSED" } });
    await withTenant(A.companyId, (db) => applyLoanDeductions(db, A.companyId, run1.id, 3, 2027, [])); // month closed with nothing selected: skipped, not deducted
    expect(Number((await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } })).outstandingBalance)).toBe(1000);

    const run2 = await owner.payrollRun.create({ data: { companyId: A.companyId, month: 4, year: 2027, createdById: A.admin.userId, status: "PROCESSED" } });
    await withTenant(A.companyId, (db) => applyLoanDeductions(db, A.companyId, run2.id, 4, 2027, [loanId]));
    const run3 = await owner.payrollRun.create({ data: { companyId: A.companyId, month: 5, year: 2027, createdById: A.admin.userId, status: "PROCESSED" } });
    await withTenant(A.companyId, (db) => applyLoanDeductions(db, A.companyId, run3.id, 5, 2027, [loanId]));
    let loan = await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } });
    expect(Number(loan.outstandingBalance)).toBe(333.32);
    expect(loan.status).toBe("APPROVED");

    const run4 = await owner.payrollRun.create({ data: { companyId: A.companyId, month: 6, year: 2027, createdById: A.admin.userId, status: "PROCESSED" } });
    const eligible = await withTenant(A.companyId, (db) => eligibleLoansFor(db, A.companyId, 6, 2027));
    expect(eligible.find((l) => l.id === loanId)?.plannedAmount).toBe(333.32); // min(installment, remaining) absorbs the remainder
    await withTenant(A.companyId, (db) => applyLoanDeductions(db, A.companyId, run4.id, 6, 2027, [loanId]));
    loan = await owner.employeeLoan.findUniqueOrThrow({ where: { id: loanId } });
    expect(Number(loan.outstandingBalance)).toBe(0);
    expect(loan.status).toBe("CLOSED"); // fully repaid
  });

  it("a loan for someone who has since left the company is no longer offered", async () => {
    const { loanId } = await withTenant(A.companyId, (db) => applyForLoan(db, A.employee, { employeeId: A.ids.employee, type: "LOAN", principalAmount: 1000, tenureMonths: 1 }));
    await withTenant(A.companyId, (db) => decideLoan(db, A.payroll, { loanId, action: "APPROVE" }));
    await owner.employee.update({ where: { id: A.ids.employee }, data: { status: "TERMINATED", dateOfExit: new Date("2020-01-01") } });

    const eligible = await withTenant(A.companyId, (db) => eligibleLoansFor(db, A.companyId, 7, 2027));
    expect(eligible.map((l) => l.id)).not.toContain(loanId);
    await owner.employee.update({ where: { id: A.ids.employee }, data: { status: "ACTIVE", dateOfExit: null } }); // restore for tests that follow
  });
});

describe("employee category and optional last name", () => {
  it("defaults category to white collar, and creates fine with no last name", async () => {
    const { employeeId } = await withTenant(A.companyId, (db) =>
      createEmployeeWithLogin(db, A.admin, {
        employeeCode: "NOLNAME", firstName: "Cher", email: `cher-${Date.now()}@loans-alpha.test`,
        dateOfJoining: new Date("2024-01-01"), state: "Karnataka", passwordHash: "x",
      })
    );
    const employee = await owner.employee.findUniqueOrThrow({ where: { id: employeeId } });
    expect(employee.lastName).toBe("");
    expect(employee.category).toBe("WHITE_COLLAR");
  });

  it("accepts an explicit category", async () => {
    const { employeeId } = await withTenant(A.companyId, (db) =>
      createEmployeeWithLogin(db, A.admin, {
        employeeCode: "BLUE1", firstName: "Ramesh", email: `ramesh-${Date.now()}@loans-alpha.test`,
        dateOfJoining: new Date("2024-01-01"), state: "Karnataka", passwordHash: "x", category: "BLUE_COLLAR",
      })
    );
    expect((await owner.employee.findUniqueOrThrow({ where: { id: employeeId } })).category).toBe("BLUE_COLLAR");
  });
});

describe("tenant isolation", () => {
  it("keeps loans inside their own company", async () => {
    const B = await makeWorld("bravo-iso");
    const { loanId } = await withTenant(B.companyId, (db) => applyForLoan(db, B.employee, { employeeId: B.ids.employee, type: "LOAN", principalAmount: 500, tenureMonths: 1 }));

    expect(await withTenant(A.companyId, (db) => db.employeeLoan.findUnique({ where: { id: loanId } }))).toBeNull();
    expect((await withTenant(A.companyId, (db) => db.employeeLoan.findMany())).every((l) => l.companyId === A.companyId)).toBe(true);

    await expect(
      owner.employeeLoan.create({ data: { companyId: A.companyId, employeeId: B.ids.employee, type: "LOAN", principalAmount: 1, tenureMonths: 1, monthlyInstallment: 1, outstandingBalance: 1, appliedDate: new Date() } })
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});
