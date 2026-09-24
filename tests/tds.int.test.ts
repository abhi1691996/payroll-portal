import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { mergeGrants, type TenantCtx } from "@/server/rbac/context";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import { assignSalary, loadTemplates } from "@/server/salary/service";
import { financialYearOf, fyMonths } from "@/lib/fy";
import {
  approveTdsComputation,
  createAndApproveTdsComputation,
  createTdsComputation,
  defaultDeductionLines,
  latestApprovedTds,
  previewTdsComputation,
  projectAnnualGrossIncome,
  tdsDeductedSoFar,
  withdrawTdsComputation,
} from "@/server/tds/service";

const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

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
  ids: { employee: string };
}

async function makeWorld(tag: string): Promise<World> {
  const { companyId, roleIds, adminUserId } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name: `TDS ${tag}`, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: "Admin", email: `admin@tds-${tag}.test`, password: "Password@123" },
    })
  );
  const emp = await owner.user.create({
    data: {
      companyId, email: `emp@tds-${tag}.test`, passwordHash: "x", name: "Employee",
      userRoles: { create: { roleId: roleIds.get("EMPLOYEE")!, companyId } },
      employee: { create: { companyId, employeeCode: "E1", firstName: "E1", lastName: "Person", state: "Karnataka", dateOfJoining: new Date("2020-01-01") } },
    },
    include: { employee: true },
  });
  const p = await owner.user.create({
    data: { companyId, email: `payroll@tds-${tag}.test`, passwordHash: "x", name: "Payroll", userRoles: { create: { roleId: roleIds.get("PAYROLL_MANAGER")!, companyId } } },
  });
  return {
    companyId,
    admin: ctxOf(companyId, { id: adminUserId, email: `admin@tds-${tag}.test` }, null, ["COMPANY_ADMIN"]),
    payroll: ctxOf(companyId, p, null, ["PAYROLL_MANAGER"]),
    employee: ctxOf(companyId, emp, emp.employee!.id, ["EMPLOYEE"]),
    ids: { employee: emp.employee!.id },
  };
}

/** Fabricates a processed payslip directly (bypassing the Server Action, which needs a request context)
 * so the projection/deduction-sum helpers have real data to read. */
async function fakePayslip(companyId: string, employeeId: string, year: number, month: number, grossPay: number, tds: number) {
  const run = await owner.payrollRun.upsert({
    where: { companyId_month_year: { companyId, month, year } },
    create: { companyId, month, year, status: "PROCESSED", createdById: (await owner.user.findFirstOrThrow({ where: { companyId } })).id },
    update: {},
  });
  await owner.payslip.upsert({
    where: { payrollRunId_employeeId: { payrollRunId: run.id, employeeId } },
    create: {
      companyId, payrollRunId: run.id, employeeId, grossPay, netPay: grossPay - tds, totalDeductions: tds,
      breakdown: { employeeDeductions: { providentFund: 0, esi: 0, professionalTax: 0, tds }, grossPay, netPay: grossPay - tds, totalDeductions: tds, earnings: { basic: 0, hra: 0, specialAllowance: 0, otherAllowances: 0 }, lopDays: 0 },
    },
    update: {},
  });
}

let A: World;

beforeAll(async () => { A = await makeWorld("alpha"); });
afterAll(async () => { await owner.$disconnect(); await basePrisma.$disconnect(); });

describe("projecting income and TDS already deducted", () => {
  it("sums actual gross from processed payslips, then projects the rest of the FY from the current salary", async () => {
    const fy = 2030; // a year with no real payroll history, so we control every input
    const [template] = await withTenant(A.companyId, (db) => loadTemplates(db));
    await withTenant(A.companyId, (db) =>
      assignSalary(db, A.admin, { employeeId: A.ids.employee, templateId: template.id, ctcAnnual: 1200000, effectiveFrom: day(`${fy}-04-01`), employerPfOptIn: true })
    );
    // Two months already paid at 50,000 gross each.
    await fakePayslip(A.companyId, A.ids.employee, fy, 4, 50000, 2000);
    await fakePayslip(A.companyId, A.ids.employee, fy, 5, 50000, 2000);

    const projected = await withTenant(A.companyId, (db) => projectAnnualGrossIncome(db, A.ids.employee, fy));
    // 2 months actual (100,000) + 10 months projected at the current salary's monthly gross.
    const monthlyGross = await owner.employeeSalary.findFirstOrThrow({ where: { employeeId: A.ids.employee, effectiveFrom: day(`${fy}-04-01`) } });
    expect(projected).toBeCloseTo(100000 + Number(monthlyGross.grossMonthly) * 10, 2);

    const { amount, remainingMonths } = await withTenant(A.companyId, (db) => tdsDeductedSoFar(db, A.ids.employee, fy));
    expect(amount).toBe(4000);
    expect(remainingMonths).toBe(10);
  });

  it("fyMonths / financialYearOf agree on the April-March window", () => {
    expect(financialYearOf(2026, 4)).toBe(2026);
    expect(financialYearOf(2027, 3)).toBe(2026);
    expect(financialYearOf(2027, 4)).toBe(2027);
    const months = fyMonths(2026);
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ year: 2026, month: 4 });
    expect(months.at(-1)).toEqual({ year: 2027, month: 3 });
  });
});

describe("creating and approving versions", () => {
  const fy = 2031;

  it("V1 needs no reason; only one computation can ever be APPROVED at a time", async () => {
    const v1 = await withTenant(A.companyId, (db) =>
      createTdsComputation(db, A.payroll, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "NEW", grossIncome: 900000, deductionLines: defaultDeductionLines("NEW") })
    );
    expect(v1.version).toBe(1);
    expect(v1.status).toBe("DRAFT");

    await withTenant(A.companyId, (db) => approveTdsComputation(db, A.payroll, v1.id));
    expect((await owner.tdsComputation.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("APPROVED");

    const active = await withTenant(A.companyId, (db) => latestApprovedTds(db, A.ids.employee, fy));
    expect(active?.id).toBe(v1.id);
  });

  it("revising without a reason is rejected; approving V2 supersedes V1", async () => {
    await expect(
      withTenant(A.companyId, (db) =>
        createTdsComputation(db, A.payroll, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "NEW", grossIncome: 1200000, deductionLines: defaultDeductionLines("NEW") })
      )
    ).rejects.toThrow(/reason/);

    const v2 = await withTenant(A.companyId, (db) =>
      createTdsComputation(db, A.payroll, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "NEW", grossIncome: 1200000, deductionLines: defaultDeductionLines("NEW"), revisionReason: "Salary revised" })
    );
    expect(v2.version).toBe(2);

    // Not active until approved: V1 is still what payroll would use.
    expect((await withTenant(A.companyId, (db) => latestApprovedTds(db, A.ids.employee, fy)))?.version).toBe(1);

    await withTenant(A.companyId, (db) => approveTdsComputation(db, A.payroll, v2.id));
    expect((await owner.tdsComputation.findFirstOrThrow({ where: { employeeId: A.ids.employee, financialYear: fy, version: 1 } })).status).toBe("SUPERSEDED");
    expect((await withTenant(A.companyId, (db) => latestApprovedTds(db, A.ids.employee, fy)))?.version).toBe(2);
  });

  it("a discarded draft is withdrawn, not deleted, and never becomes active", async () => {
    const v3 = await withTenant(A.companyId, (db) =>
      createTdsComputation(db, A.payroll, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "NEW", grossIncome: 1300000, deductionLines: defaultDeductionLines("NEW"), revisionReason: "What-if" })
    );
    await withTenant(A.companyId, (db) => withdrawTdsComputation(db, A.payroll, v3.id));
    expect((await owner.tdsComputation.findUniqueOrThrow({ where: { id: v3.id } })).status).toBe("WITHDRAWN");
    expect((await withTenant(A.companyId, (db) => latestApprovedTds(db, A.ids.employee, fy)))?.version).toBe(2);

    await expect(withTenant(A.companyId, (db) => approveTdsComputation(db, A.payroll, v3.id))).rejects.toThrow(/draft/);
    await expect(withTenant(A.companyId, (db) => withdrawTdsComputation(db, A.payroll, v3.id))).rejects.toThrow(/draft/);
  });

  it("compute-and-approve does both in one call", async () => {
    const v4 = await withTenant(A.companyId, (db) =>
      createAndApproveTdsComputation(db, A.payroll, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "OLD", grossIncome: 1000000, deductionLines: defaultDeductionLines("OLD"), revisionReason: "Switched to old regime" })
    );
    expect(v4.status).toBe("APPROVED");
    expect(v4.taxRegime).toBe("OLD");
    const active = await withTenant(A.companyId, (db) => latestApprovedTds(db, A.ids.employee, fy));
    expect(active?.id).toBe(v4.id);
  });

  it("an employee can't compute their own TDS (permission-gated to tds.manage)", async () => {
    await expect(
      withTenant(A.companyId, (db) =>
        createTdsComputation(db, A.employee, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "NEW", grossIncome: 900000, deductionLines: [] })
      )
    ).rejects.toThrow(/permission/);
  });
});

describe("preview", () => {
  it("defaults to the projected gross income and regime-appropriate standard deduction when nothing is overridden", async () => {
    const fy = 2032;
    const preview = await withTenant(A.companyId, (db) => previewTdsComputation(db, { employeeId: A.ids.employee, financialYear: fy, taxRegime: "NEW" }));
    expect(preview.deductionLines).toEqual(defaultDeductionLines("NEW"));
    expect(preview.remainingMonths).toBe(12);
    expect(preview.tdsAlreadyDeducted).toBe(0);
    expect(preview.grossIncome).toBeGreaterThan(0);
  });
});

describe("tenant isolation", () => {
  it("keeps computations inside their own company", async () => {
    const B = await makeWorld("bravo-iso");
    const comp = await withTenant(B.companyId, (db) =>
      createTdsComputation(db, B.payroll, { employeeId: B.ids.employee, financialYear: 2031, taxRegime: "NEW", grossIncome: 800000, deductionLines: defaultDeductionLines("NEW") })
    );
    expect(await withTenant(A.companyId, (db) => db.tdsComputation.findUnique({ where: { id: comp.id } }))).toBeNull();
    expect((await withTenant(A.companyId, (db) => db.tdsComputation.findMany())).every((c) => c.companyId === A.companyId)).toBe(true);

    await expect(
      owner.tdsComputation.create({
        data: {
          companyId: A.companyId, employeeId: B.ids.employee, financialYear: 2031, version: 1, taxRegime: "NEW",
          grossIncome: 1, deductionLines: [], totalDeductions: 0, taxableIncome: 1, taxLiability: 0, cess: 0,
          annualTdsLiability: 0, tdsAlreadyDeducted: 0, balanceTds: 0, remainingMonths: 12, monthlyTds: 0,
        },
      })
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});
