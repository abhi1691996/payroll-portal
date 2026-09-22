/**
 * SUPERSEDED. This one-off import targets the schema as of migration 20260921130000 and has already been run.
 * It is kept for reference only and is excluded from type-checking: the salary and leave tables it writes to
 * were replaced afterwards (see prisma/migrations/*_shifts_attendance_salary_leave_approvals).
 */
/**
 * One-off: imports the pre-multi-tenant SQLite database (prisma/dev.db) into the new Postgres schema
 * as tenant #1.
 *
 *   npm run db:legacy:generate     (once: builds a read-only client for the old schema)
 *   npm run db:seed                (permission catalogue, plans, Super Admin)
 *   npm run db:migrate-legacy -- prisma/dev.db
 *
 * - The old single Company row becomes the first tenant; every other row is stamped with its id.
 * - ALL ids are preserved, so payslip -> run -> employee references stay intact.
 * - Users keep their password hashes. ADMIN -> COMPANY_ADMIN, EMPLOYEE -> EMPLOYEE.
 * - Runs in ONE transaction and verifies counts + payslip totals before committing.
 * - The source file is copied first and never modified.
 */
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createCompanyShell } from "../src/server/companies/provision";

const source = resolve(process.argv[2] ?? "prisma/dev.db");
if (!existsSync(source)) {
  console.error(`Legacy database not found: ${source}`);
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), "legacy-"));
const copy = join(workDir, "legacy.db");
copyFileSync(source, copy);
process.env.LEGACY_DATABASE_URL = `file:${copy.replaceAll("\\", "/")}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadLegacyClient(): Promise<any> {
  const modulePath = resolve("node_modules/.legacy-prisma/index.js");
  if (!existsSync(modulePath)) {
    console.error("Legacy client missing. Run:  npm run db:legacy:generate");
    process.exit(1);
  }
  const mod = await import(`file://${modulePath.replaceAll("\\", "/")}`);
  const Client = mod.PrismaClient ?? mod.default?.PrismaClient;
  return new Client();
}

const num = (v: unknown): string => String(v);
const chunk = <T>(rows: T[], size = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

async function main() {
  const legacy = await loadLegacyClient();
  // Owner connection: bypasses RLS (this is a trusted, one-off data load).
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

  try {
    const [company, users, employees, structures, attendance, leaveTypes, balances, requests, configs, runs, payslips] =
      await Promise.all([
        legacy.company.findFirst(),
        legacy.user.findMany(),
        legacy.employee.findMany(),
        legacy.salaryStructure.findMany(),
        legacy.attendanceRecord.findMany(),
        legacy.leaveType.findMany(),
        legacy.leaveBalance.findMany(),
        legacy.leaveRequest.findMany(),
        legacy.statutoryConfig.findMany(),
        legacy.payrollRun.findMany(),
        legacy.payslip.findMany(),
      ]);

    if (!company) throw new Error("The legacy database has no Company row — nothing to migrate.");
    if (await prisma.company.findUnique({ where: { id: company.id } })) {
      throw new Error(`Company ${company.id} is already migrated. Aborting to avoid duplicates.`);
    }
    const clashing = await prisma.user.findMany({
      where: { email: { in: users.map((u: any) => u.email.toLowerCase()) } },
      select: { email: true },
    });
    if (clashing.length > 0) {
      throw new Error(
        `These login emails already exist in the new database: ${clashing.map((c) => c.email).join(", ")}. ` +
          "Reset the database (or remove the demo company) before migrating."
      );
    }

    console.log(
      `Legacy data: ${users.length} users, ${employees.length} employees, ${structures.length} salary structures, ` +
        `${attendance.length} attendance rows, ${requests.length} leave requests, ${runs.length} payroll runs, ${payslips.length} payslips`
    );

    await prisma.$transaction(
      async (tx) => {
        // 1. Tenant: company + subscription + system roles (same id as the old company row).
        const { companyId, roleIds } = await createCompanyShell(
          tx,
          {
            name: company.name,
            address: company.address,
            state: company.state,
            pan: company.pan ?? undefined,
            tan: company.tan ?? undefined,
            pfEstablishmentId: company.pfEstablishmentId ?? undefined,
            esiEstablishmentId: company.esiEstablishmentId ?? undefined,
            payCycleStartDay: company.payCycleStartDay,
            status: "ACTIVE",
          },
          "STARTER",
          company.id,
          false // the legacy data brings its own statutory rates and leave types
        );

        // 2. Statutory rates: per company now, so they are stamped with the new tenant.
        await tx.statutoryConfig.createMany({
          data: configs.map((c: any) => ({
            id: c.id,
            companyId,
            effectiveFrom: c.effectiveFrom,
            pfEmployeeRate: num(c.pfEmployeeRate),
            pfEmployerRate: num(c.pfEmployerRate),
            pfWageCeiling: num(c.pfWageCeiling),
            esiEmployeeRate: num(c.esiEmployeeRate),
            esiEmployerRate: num(c.esiEmployerRate),
            esiWageThreshold: num(c.esiWageThreshold),
            professionalTaxSlabs: c.professionalTaxSlabs,
            incomeTaxSlabs: c.incomeTaxSlabs,
          })),
        });

        // 3. Users, keeping ids and password hashes.
        const employeeByUser = new Map(employees.map((e: any) => [e.userId, e]));
        for (const u of users) {
          const emp: any = employeeByUser.get(u.id);
          await tx.user.create({
            data: {
              id: u.id,
              companyId,
              email: u.email.toLowerCase(),
              passwordHash: u.passwordHash,
              name: emp ? `${emp.firstName} ${emp.lastName}` : "Company Admin",
              status: "ACTIVE",
              createdAt: u.createdAt,
            },
          });
          await tx.userRole.create({
            data: {
              userId: u.id,
              companyId,
              roleId: roleIds.get(u.role === "ADMIN" ? "COMPANY_ADMIN" : "EMPLOYEE")!,
            },
          });
        }

        // 4. Tenant data, ids preserved, stamped with the new companyId.
        // The tax regime now lives on the employee: take the one from their latest salary structure.
        const latestRegime = new Map<string, string>();
        for (const s of [...structures].sort((a: any, b: any) => +new Date(a.effectiveFrom) - +new Date(b.effectiveFrom))) {
          latestRegime.set(s.employeeId, s.taxRegime);
        }
        await tx.employee.createMany({
          data: employees.map((e: any) => ({ ...e, companyId, taxRegime: latestRegime.get(e.id) ?? "NEW" })),
        });
        await tx.salaryStructure.createMany({
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          data: structures.map(({ taxRegime: _regime, ...s }: any) => ({
            ...s,
            companyId,
            ctcAnnual: num(s.ctcAnnual),
            basicMonthly: num(s.basicMonthly),
            hraMonthly: num(s.hraMonthly),
            specialAllowance: num(s.specialAllowance),
            otherAllowances: num(s.otherAllowances),
          })),
        });
        await tx.leaveType.createMany({ data: leaveTypes.map((t: any) => ({ ...t, companyId })) });
        for (const part of chunk(attendance)) {
          await tx.attendanceRecord.createMany({ data: part.map((a: any) => ({ ...a, companyId })) });
        }
        await tx.leaveBalance.createMany({
          data: balances.map((b: any) => ({ ...b, companyId, balance: num(b.balance) })),
        });
        await tx.leaveRequest.createMany({ data: requests.map((r: any) => ({ ...r, companyId })) });
        await tx.payrollRun.createMany({ data: runs.map((r: any) => ({ ...r, companyId })) });
        for (const part of chunk(payslips)) {
          await tx.payslip.createMany({
            data: part.map((p: any) => ({
              ...p,
              companyId,
              grossPay: num(p.grossPay),
              netPay: num(p.netPay),
              totalDeductions: num(p.totalDeductions),
            })),
          });
        }

        await tx.auditLog.create({
          data: {
            companyId,
            actorEmail: "system",
            module: "migration",
            action: "legacy.import",
            newValue: { source: "prisma/dev.db", employees: employees.length, payslips: payslips.length },
          },
        });

        // 5. Verify before committing: anything off rolls the whole migration back.
        const check = async (label: string, expected: number, actual: number) => {
          if (expected !== actual) throw new Error(`Verification failed for ${label}: expected ${expected}, got ${actual}`);
        };
        await check("users", users.length, await tx.user.count({ where: { companyId } }));
        await check("employees", employees.length, await tx.employee.count({ where: { companyId } }));
        await check("salary structures", structures.length, await tx.salaryStructure.count({ where: { companyId } }));
        await check("attendance", attendance.length, await tx.attendanceRecord.count({ where: { companyId } }));
        await check("leave requests", requests.length, await tx.leaveRequest.count({ where: { companyId } }));
        await check("payroll runs", runs.length, await tx.payrollRun.count({ where: { companyId } }));
        await check("payslips", payslips.length, await tx.payslip.count({ where: { companyId } }));

        const oldNet = payslips.reduce((sum: number, p: any) => sum + Number(p.netPay), 0);
        const newNet = Number((await tx.payslip.aggregate({ where: { companyId }, _sum: { netPay: true } }))._sum.netPay ?? 0);
        if (Math.abs(oldNet - newNet) > 0.005) throw new Error(`Net pay total mismatch: ${oldNet} vs ${newNet}`);
      },
      { timeout: 120_000, maxWait: 10_000 }
    );

    console.log(`Migrated "${company.name}" as tenant ${company.id}. All counts and payslip totals verified.`);
  } finally {
    await legacy.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
