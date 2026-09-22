/**
 * Idempotent platform bootstrap. Safe to run on every deploy.
 *
 *   npm run db:seed            permission catalogue, plans, Super Admin
 *   npm run db:seed -- --demo  ...plus two demo companies (Acme, Globex) for local development
 *
 * Runs as the database OWNER (DIRECT_URL) so it can write the read-only catalogue tables and is not
 * subject to Row-Level Security. Never point the running application at that connection.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PERMISSIONS } from "../src/server/rbac/permissions";
import { provisionCompany, seedSystemRoles } from "../src/server/companies/provision";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

async function syncPermissions() {
  const keys = Object.keys(PERMISSIONS);
  for (const [key, meta] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, module: meta.module, description: meta.description },
      update: { module: meta.module, description: meta.description },
    });
  }
  // Permissions removed from the code are removed from the catalogue (cascades to role grants).
  await prisma.permission.deleteMany({ where: { key: { notIn: keys } } });

  // Existing companies pick up any permissions newly granted to system roles.
  const companies = await prisma.company.findMany({ select: { id: true } });
  for (const c of companies) await seedSystemRoles(prisma, c.id);
  console.log(`Permissions synced (${keys.length}); system roles refreshed for ${companies.length} company(ies).`);
}

async function seedPlans() {
  // Prices are placeholders — set real pricing from the platform portal.
  const plans = [
    { code: "TRIAL", name: "Free trial", maxEmployees: 25, priceMonthly: 0 },
    { code: "STARTER", name: "Starter", maxEmployees: 50, priceMonthly: 0 },
    { code: "GROWTH", name: "Growth", maxEmployees: 250, priceMonthly: 0 },
    { code: "BUSINESS", name: "Business", maxEmployees: null, priceMonthly: 0 },
  ];
  for (const p of plans) {
    await prisma.plan.upsert({ where: { code: p.code }, create: p, update: { name: p.name, maxEmployees: p.maxEmployees } });
  }
}

async function seedSuperAdmin() {
  const email = (process.env.SUPER_ADMIN_EMAIL ?? "superadmin@platform.test").toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD ?? "SuperAdmin@12345";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;
  await prisma.user.create({
    data: {
      email,
      name: "Platform Admin",
      passwordHash: await bcrypt.hash(password, 10),
      platformRole: "SUPER_ADMIN",
      status: "ACTIVE",
    },
  });
  console.log(`Super Admin created: ${email} / ${password}   <-- change this before going live`);
}

async function seedDemoCompany(opts: {
  name: string;
  state: string;
  adminEmail: string;
  employees: { code: string; first: string; last: string; dept: string; title: string; ctc: number; basic: number; hra: number; special: number }[];
}) {
  const existing = await prisma.user.findUnique({ where: { email: opts.adminEmail } });
  if (existing) return;

  // One transaction: a failure leaves no half-built company behind (and the seed can simply be re-run).
  await prisma.$transaction(async (tx) => {
  const { companyId, roleIds } = await provisionCompany(tx, {
    company: { name: opts.name, address: `1 Demo Street, ${opts.state}`, state: opts.state, status: "ACTIVE" },
    admin: { name: `${opts.name} Admin`, email: opts.adminEmail, password: "Admin@12345" },
    planCode: "STARTER",
  });

  const passwordHash = await bcrypt.hash("Employee@12345", 10);
  const domain = opts.adminEmail.split("@")[1];
  for (const e of opts.employees) {
    await tx.user.create({
      data: {
        companyId,
        email: `${e.first}.${e.last}@${domain}`.toLowerCase(),
        name: `${e.first} ${e.last}`,
        passwordHash,
        userRoles: { create: { roleId: roleIds.get("EMPLOYEE")!, companyId } },
        employee: {
          create: {
            companyId,
            employeeCode: e.code,
            firstName: e.first,
            lastName: e.last,
            department: e.dept,
            designation: e.title,
            state: opts.state,
            dateOfJoining: new Date("2023-06-01"),
            salaries: {
              // companyId is inherited from the parent through the composite relation.
              create: {
                effectiveFrom: new Date("2024-04-01"),
                ctcAnnual: e.ctc,
                grossMonthly: e.basic + e.hra + e.special,
                lines: [
                  { code: "BASIC", name: "Basic", monthlyAmount: e.basic, isBasic: true, taxable: true, includeInPf: true, includeInEsi: true, includeInPt: true, sortOrder: 1 },
                  { code: "HRA", name: "HRA", monthlyAmount: e.hra, isBasic: false, taxable: true, includeInPf: false, includeInEsi: true, includeInPt: true, sortOrder: 2 },
                  { code: "SPECIAL", name: "Special Allowance", monthlyAmount: e.special, isBasic: false, taxable: true, includeInPf: false, includeInEsi: true, includeInPt: true, sortOrder: 3 },
                  { code: "OTHER", name: "Other Allowances", monthlyAmount: 0, isBasic: false, taxable: true, includeInPf: false, includeInEsi: true, includeInPt: true, sortOrder: 4 },
                ],
              },
            },
          },
        },
      },
    });
  }
  }, { timeout: 60_000 });

  console.log(`Demo company "${opts.name}": ${opts.adminEmail} / Admin@12345 (employees use Employee@12345)`);
}

async function main() {
  await syncPermissions();
  await seedPlans();
  await seedSuperAdmin();

  const demo = process.argv.includes("--demo");
  // --demo-globex adds only the second company (used after migrating legacy data as the first).
  if (demo) {
    await seedDemoCompany({
      name: "Acme Innovations Pvt Ltd",
      state: "Karnataka",
      adminEmail: "admin@acme.test",
      employees: [
        { code: "EMP001", first: "Priya", last: "Sharma", dept: "Engineering", title: "Software Engineer", ctc: 900000, basic: 30000, hra: 12000, special: 18000 },
        { code: "EMP002", first: "Rahul", last: "Verma", dept: "Sales", title: "Sales Executive", ctc: 420000, basic: 14000, hra: 5600, special: 5400 },
      ],
    });
  }
  if (demo || process.argv.includes("--demo-globex")) {
    await seedDemoCompany({
      name: "Globex Traders LLP",
      state: "Maharashtra",
      adminEmail: "admin@globex.test",
      employees: [
        // Deliberately reuses Acme's employee code EMP001: codes are unique per company, not globally.
        { code: "EMP001", first: "Neha", last: "Kulkarni", dept: "Operations", title: "Operations Lead", ctc: 720000, basic: 24000, hra: 9600, special: 14400 },
      ],
    });
  }
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
