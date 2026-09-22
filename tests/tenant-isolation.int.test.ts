import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { basePrisma } from "@/server/tenancy/base-client";
import { TenantIsolationError, withPlatform, withTenant } from "@/server/tenancy/db";
import { provisionCompany } from "@/server/companies/provision";
import { createEmployeeWithLogin } from "@/server/employees/service";
import { findTakenEmails } from "@/server/users/email-registry";
import { audit } from "@/server/audit/audit";
import { IMPORTERS } from "@/lib/bulk/importers";
import { parseCsvRecords } from "@/lib/csv";
import type { TenantCtx } from "@/server/rbac/context";

/**
 * Two companies with overlapping data. Every test tries to cross the boundary and must fail.
 * Fixtures are created as the database OWNER (bypasses RLS); everything under test uses the
 * application role, exactly like production.
 */
const owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

interface Tenant {
  companyId: string;
  adminUserId: string;
  employeeId: string;
  leaveTypeId: string;
  ctx: TenantCtx;
}

async function makeTenant(name: string): Promise<Tenant> {
  const { companyId, adminUserId, roleIds } = await owner.$transaction((tx) =>
    provisionCompany(tx, {
      company: { name, address: "1 Test Road", state: "Karnataka", status: "ACTIVE" },
      admin: { name: `${name} Admin`, email: `admin@${name.toLowerCase()}.test`, password: "Password@123" },
    })
  );
  // provisionCompany already created the default leave types.
  const leaveType = await owner.leaveType.findFirstOrThrow({ where: { companyId, name: "Casual Leave" } });
  // Same employee code in BOTH companies: codes are unique per company, not globally.
  const user = await owner.user.create({
    data: {
      companyId,
      email: `emp1@${name.toLowerCase()}.test`,
      passwordHash: "x",
      userRoles: { create: { roleId: roleIds.get("EMPLOYEE")!, companyId } },
      employee: {
        create: {
          companyId,
          employeeCode: "EMP001",
          firstName: name,
          lastName: "Employee",
          state: "Karnataka",
          dateOfJoining: new Date("2024-01-01"),
          salaries: {
            create: { effectiveFrom: new Date("2024-04-01"), ctcAnnual: 600000, grossMonthly: 50000, lines: [] },
          },
        },
      },
    },
    include: { employee: true },
  });
  return {
    companyId,
    adminUserId,
    employeeId: user.employee!.id,
    leaveTypeId: leaveType.id,
    ctx: {
      userId: adminUserId,
      email: `admin@${name.toLowerCase()}.test`,
      name: `${name} Admin`,
      companyId,
      isSuperAdmin: false,
      employeeId: null,
      roleKeys: ["COMPANY_ADMIN"],
      permissions: new Map(),
      ip: null,
      userAgent: null,
    },
  };
}

let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  A = await makeTenant("Alpha");
  B = await makeTenant("Bravo");
});

afterAll(async () => {
  await owner.$disconnect();
  await basePrisma.$disconnect();
});

/* ---------------------------- Layer 1: tenant client ---------------------------- */

describe("tenant client: reads", () => {
  it("returns only the caller's rows", async () => {
    const rows = await withTenant(A.companyId, (db) => db.employee.findMany());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((e) => e.companyId === A.companyId)).toBe(true);
  });

  it("findUnique on another company's id returns null", async () => {
    const found = await withTenant(A.companyId, (db) => db.employee.findUnique({ where: { id: B.employeeId } }));
    expect(found).toBeNull();
  });

  it("cannot be pointed at another tenant by putting companyId in the filter", async () => {
    const rows = await withTenant(A.companyId, (db) =>
      db.employee.findMany({ where: { companyId: B.companyId } })
    );
    expect(rows.every((e) => e.companyId === A.companyId)).toBe(true);
    expect(rows.find((e) => e.id === B.employeeId)).toBeUndefined();
  });

  it("scopes aggregates and groupBy", async () => {
    const count = await withTenant(A.companyId, (db) => db.employee.count());
    const ownerCount = await owner.employee.count({ where: { companyId: A.companyId } });
    expect(count).toBe(ownerCount);
    const groups = await withTenant(A.companyId, (db) => db.employee.groupBy({ by: ["companyId"], _count: { _all: true } }));
    expect(groups.map((g) => g.companyId)).toEqual([A.companyId]);
  });

  it("scopes nested relation includes to rows the FKs allow (same company only)", async () => {
    const emp = await withTenant(A.companyId, (db) =>
      db.employee.findFirst({ where: { id: A.employeeId }, include: { salaries: true } })
    );
    expect(emp?.salaries.every((s) => s.companyId === A.companyId)).toBe(true);
  });

  it("a tenant sees only its own Company row", async () => {
    const companies = await withTenant(A.companyId, (db) => db.company.findMany());
    expect(companies.map((c) => c.id)).toEqual([A.companyId]);
  });
});

describe("tenant client: writes", () => {
  it("update/delete on another company's row finds nothing and changes nothing", async () => {
    await expect(
      withTenant(A.companyId, (db) => db.employee.update({ where: { id: B.employeeId }, data: { firstName: "Hacked" } }))
    ).rejects.toThrow();
    const bulkUpdate = await withTenant(A.companyId, (db) =>
      db.employee.updateMany({ where: { id: B.employeeId }, data: { firstName: "Hacked" } })
    );
    const bulkDelete = await withTenant(A.companyId, (db) => db.employee.deleteMany({ where: { id: B.employeeId } }));
    expect(bulkUpdate.count).toBe(0);
    expect(bulkDelete.count).toBe(0);
    const untouched = await owner.employee.findUnique({ where: { id: B.employeeId } });
    expect(untouched?.firstName).toBe("Bravo");
  });

  it("stamps the caller's companyId on create even if the caller supplies another", async () => {
    const created = await withTenant(A.companyId, (db) =>
      db.leaveType.create({ data: { companyId: B.companyId, name: "Sneaky Leave", code: "SNEAKY" } })
    );
    expect(created.companyId).toBe(A.companyId);
    expect(await owner.leaveType.count({ where: { companyId: B.companyId, name: "Sneaky Leave" } })).toBe(0);
  });

  it("refuses to move a row to another company via update", async () => {
    await expect(
      withTenant(A.companyId, (db) =>
        db.employee.update({ where: { id: A.employeeId }, data: { companyId: B.companyId } })
      )
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it("upsert cannot hit another company's row", async () => {
    // The compound key names B's row while the tenant filter says A: no match, and the create then
    // collides inside A. Whatever the outcome (error or not), B must be untouched.
    await withTenant(A.companyId, (db) =>
      db.leaveType.upsert({
        where: { companyId_name: { companyId: B.companyId, name: "Casual Leave" } },
        create: { companyId: B.companyId, name: "Casual Leave", code: "CASUAL_LEAVE", isPaid: false },
        update: { isPaid: false },
      })
    ).catch(() => undefined);
    const bravo = await owner.leaveType.findMany({ where: { companyId: B.companyId, name: "Casual Leave" } });
    expect(bravo).toHaveLength(1);
    expect(bravo[0].isPaid).toBe(true);
    expect(await owner.leaveType.count({ where: { companyId: A.companyId, name: "Casual Leave", isPaid: false } })).toBe(0);
  });

  it("allows the same employee code in different companies but not twice in one", async () => {
    const both = await owner.employee.findMany({ where: { employeeCode: "EMP001", companyId: { in: [A.companyId, B.companyId] } } });
    expect(both).toHaveLength(2);
    await expect(
      owner.employee.create({
        data: { companyId: A.companyId, employeeCode: "EMP001", firstName: "Dup", lastName: "X", state: "KA", dateOfJoining: new Date() },
      })
    ).rejects.toThrow();
  });
});

describe("tenant client: platform-owned data", () => {
  it("tenants can read but never modify plans or the permission catalogue", async () => {
    const plans = await withTenant(A.companyId, (db) => db.plan.findMany());
    expect(plans.length).toBeGreaterThan(0);
    await expect(
      withTenant(A.companyId, (db) => db.plan.create({ data: { code: "HACK", name: "Hack" } }))
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      withTenant(A.companyId, (db) => db.permission.deleteMany({}))
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it("tenants cannot create or delete companies", async () => {
    await expect(
      withTenant(A.companyId, (db) => db.company.create({ data: { name: "Rogue", address: "x", state: "x" } }))
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(withTenant(A.companyId, (db) => db.company.deleteMany({}))).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it("a tenant cannot update another company's row", async () => {
    await expect(
      withTenant(A.companyId, (db) => db.company.update({ where: { id: B.companyId }, data: { name: "Hacked" } }))
    ).rejects.toThrow();
    expect((await owner.company.findUnique({ where: { id: B.companyId } }))?.name).toBe("Bravo");
  });
});

/* ------------------- Layer 2: composite foreign keys (database) ----------------- */

describe("composite foreign keys", () => {
  it("rejects an attendance row in A that points at B's employee", async () => {
    await expect(
      owner.attendanceRecord.create({
        data: { companyId: A.companyId, employeeId: B.employeeId, date: new Date("2025-01-01"), status: "PRESENT" },
      })
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it("rejects a leave request in A using B's leave type", async () => {
    await expect(
      owner.leaveRequest.create({
        data: {
          companyId: A.companyId,
          employeeId: A.employeeId,
          leaveTypeId: B.leaveTypeId,
          startDate: new Date("2025-01-01"),
          endDate: new Date("2025-01-02"),
        },
      })
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it("rejects granting A's user a role that belongs to B", async () => {
    const bRole = await owner.role.findFirstOrThrow({ where: { companyId: B.companyId, key: "COMPANY_ADMIN" } });
    await expect(
      owner.userRole.create({ data: { userId: A.adminUserId, roleId: bRole.id, companyId: A.companyId } })
    ).rejects.toThrow(/foreign key|constraint/i);
  });
});

/* ----------------- Layer 3: Row-Level Security (application role) -------------- */

describe("row-level security", () => {
  it("returns nothing when no tenant is set, even for a raw unscoped client", async () => {
    const rows = await basePrisma.employee.findMany();
    expect(rows).toHaveLength(0);
  });

  it("with tenant A set, a raw client still cannot read B's rows", async () => {
    const rows = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A.companyId}, true)`;
      return tx.employee.findMany({ where: { companyId: B.companyId } });
    });
    expect(rows).toHaveLength(0);
  });

  it("refuses to insert a row for another company", async () => {
    await expect(
      basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A.companyId}, true)`;
        return tx.leaveType.create({ data: { companyId: B.companyId, name: "Cross", code: "CROSS" } });
      })
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("the application role cannot switch RLS off", async () => {
    await expect(basePrisma.$executeRawUnsafe("ALTER TABLE \"Employee\" DISABLE ROW LEVEL SECURITY")).rejects.toThrow();
  });
});


describe("per-company statutory rates", () => {
  it("every new company starts with prefilled default rates and leave types", async () => {
    const own = await withTenant(A.companyId, (db) => db.statutoryConfig.findMany());
    expect(own).toHaveLength(1);
    expect(Number(own[0].pfEmployeeRate)).toBeCloseTo(0.12);
    expect(Number(own[0].pfWageCeiling)).toBe(15000);
    const types = await withTenant(A.companyId, (db) => db.leaveType.findMany({ orderBy: { name: "asc" } }));
    expect(types.map((t) => t.name)).toEqual(expect.arrayContaining(["Casual Leave", "Earned Leave", "Sick Leave"]));
  });

  it("a company can add its own rate version without affecting any other company", async () => {
    await withTenant(A.companyId, (db) =>
      db.statutoryConfig.create({
        data: {
          companyId: A.companyId,
          effectiveFrom: new Date("2026-04-01"),
          pfEmployeeRate: 0.1,
          pfEmployerRate: 0.1,
          pfWageCeiling: 20000,
          esiEmployeeRate: 0.0075,
          esiEmployerRate: 0.0325,
          esiWageThreshold: 21000,
          professionalTaxSlabs: [],
          incomeTaxSlabs: {},
        },
      })
    );
    expect(await withTenant(A.companyId, (db) => db.statutoryConfig.count())).toBe(2);
    expect(await withTenant(B.companyId, (db) => db.statutoryConfig.count())).toBe(1);
  });

  it("company A cannot read, change or delete company B's rates", async () => {
    const bId = (await owner.statutoryConfig.findFirstOrThrow({ where: { companyId: B.companyId } })).id;
    expect(await withTenant(A.companyId, (db) => db.statutoryConfig.findUnique({ where: { id: bId } }))).toBeNull();
    const upd = await withTenant(A.companyId, (db) => db.statutoryConfig.updateMany({ where: { id: bId }, data: { pfWageCeiling: 1 } }));
    const del = await withTenant(A.companyId, (db) => db.statutoryConfig.deleteMany({ where: { id: bId } }));
    expect(upd.count + del.count).toBe(0);
    expect(Number((await owner.statutoryConfig.findUniqueOrThrow({ where: { id: bId } })).pfWageCeiling)).toBe(15000);
  });

  it("row-level security hides other companies' rates from a raw client too", async () => {
    const rows = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A.companyId}, true)`;
      return tx.statutoryConfig.findMany();
    });
    expect(rows.every((r) => r.companyId === A.companyId)).toBe(true);
  });
});

describe("employee tax regime", () => {
  it("defaults to the new regime and can be switched per employee", async () => {
    const before = await withTenant(A.companyId, (db) => db.employee.findUniqueOrThrow({ where: { id: A.employeeId } }));
    expect(before.taxRegime).toBe("NEW");
    await withTenant(A.companyId, (db) => db.employee.update({ where: { id: A.employeeId }, data: { taxRegime: "OLD" } }));
    expect((await owner.employee.findUniqueOrThrow({ where: { id: A.employeeId } })).taxRegime).toBe("OLD");
    // The other company's employee is unaffected.
    expect((await owner.employee.findUniqueOrThrow({ where: { id: B.employeeId } })).taxRegime).toBe("NEW");
  });

  it("company A cannot change company B's employee regime", async () => {
    const r = await withTenant(A.companyId, (db) =>
      db.employee.updateMany({ where: { id: B.employeeId }, data: { taxRegime: "OLD" } })
    );
    expect(r.count).toBe(0);
    expect((await owner.employee.findUniqueOrThrow({ where: { id: B.employeeId } })).taxRegime).toBe("NEW");
  });

  it("new employees can be created with the old regime", async () => {
    const { employeeId } = await withTenant(A.companyId, (db) =>
      createEmployeeWithLogin(db, A.ctx, {
        employeeCode: "EMP901",
        firstName: "Old",
        lastName: "Regime",
        email: "old.regime@alpha.test",
        dateOfJoining: new Date("2025-01-01"),
        state: "Karnataka",
        taxRegime: "OLD",
        passwordHash: "x",
      })
    );
    expect((await owner.employee.findUniqueOrThrow({ where: { id: employeeId } })).taxRegime).toBe("OLD");
  });
});

describe("company provisioning", () => {
  it("creates the tenant, six system roles, an invited admin and one-time invitation", async () => {
    const result = await owner.$transaction((tx) =>
      provisionCompany(tx, {
        company: { name: "Charlie", address: "3 Test Road", state: "Kerala" },
        admin: { name: "Charlie Admin", email: "admin@charlie.test" },
      })
    );
    expect(result.inviteToken).toBeTruthy();
    expect(await owner.role.count({ where: { companyId: result.companyId } })).toBe(6);
    const admin = await owner.user.findUniqueOrThrow({ where: { id: result.adminUserId } });
    expect(admin.status).toBe("INVITED");
    const inv = await owner.invitation.findFirstOrThrow({ where: { userId: admin.id } });
    // Only a hash of the token is stored.
    expect(inv.tokenHash).not.toBe(result.inviteToken);
    expect(inv.tokenHash).toHaveLength(64);
    expect(await owner.statutoryConfig.count({ where: { companyId: result.companyId } })).toBe(1);
  });
});

/* -------------------------------- Audit log ------------------------------------ */

describe("audit log", () => {
  it("records tenant events and is invisible to other tenants", async () => {
    await withTenant(A.companyId, (db) =>
      audit(db, A.ctx, { module: "test", action: "isolation.check", entityType: "Employee", entityId: A.employeeId })
    );
    const mine = await withTenant(A.companyId, (db) => db.auditLog.findMany({ where: { action: "isolation.check" } }));
    const theirs = await withTenant(B.companyId, (db) => db.auditLog.findMany({ where: { action: "isolation.check" } }));
    expect(mine.length).toBe(1);
    expect(theirs).toHaveLength(0);
  });

  it("redacts secrets before storing", async () => {
    await withTenant(A.companyId, (db) =>
      audit(db, A.ctx, { module: "test", action: "redact.check", newValue: { name: "x", passwordHash: "secret", nested: { tempPassword: "pw" } } })
    );
    const row = await withTenant(A.companyId, (db) => db.auditLog.findFirstOrThrow({ where: { action: "redact.check" } }));
    expect(JSON.stringify(row.newValue)).not.toMatch(/secret|"pw"/);
  });

  it("cannot be edited or deleted, even by the application role", async () => {
    const row = await withTenant(A.companyId, (db) => db.auditLog.findFirstOrThrow({ where: { action: "isolation.check" } }));
    await expect(
      basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A.companyId}, true)`;
        return tx.auditLog.update({ where: { id: row.id }, data: { action: "tampered" } });
      })
    ).rejects.toThrow();
    await expect(
      basePrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${A.companyId}, true)`;
        return tx.auditLog.delete({ where: { id: row.id } });
      })
    ).rejects.toThrow();
  });
});

/* ------------------------- Services and bulk import ------------------------------ */

describe("services", () => {
  it("email uniqueness is platform-wide and reports only taken/not taken", async () => {
    const taken = await findTakenEmails(["emp1@alpha.test", "EMP1@BRAVO.TEST", "nobody@x.test"]);
    expect(taken).toEqual(new Set(["emp1@alpha.test", "emp1@bravo.test"]));
  });

  it("creating an employee in A yields a login only A can see", async () => {
    const { userId } = await withTenant(A.companyId, (db) =>
      createEmployeeWithLogin(db, A.ctx, {
        employeeCode: "EMP900",
        firstName: "New",
        lastName: "Hire",
        email: "new.hire@alpha.test",
        dateOfJoining: new Date("2025-01-01"),
        state: "Karnataka",
        passwordHash: "x",
      })
    );
    expect(await withTenant(A.companyId, (db) => db.user.findUnique({ where: { id: userId } }))).not.toBeNull();
    expect(await withTenant(B.companyId, (db) => db.user.findUnique({ where: { id: userId } }))).toBeNull();
  });

  it("platform mode (login lookup) can see users in every company", async () => {
    const users = await withPlatform((db) =>
      db.user.findMany({ where: { email: { in: ["admin@alpha.test", "admin@bravo.test"] } } })
    );
    expect(users).toHaveLength(2);
  });
});

describe("bulk import respects tenancy", () => {
  it("a salary upload in A cannot address B's employee code and flags it as unknown", async () => {
    // Bravo has EMP001 too, but only A's own EMP001 resolves. Use a code that exists ONLY in Bravo.
    await owner.employee.create({
      data: { companyId: B.companyId, employeeCode: "ONLYB", firstName: "Only", lastName: "Bravo", state: "KA", dateOfJoining: new Date("2024-01-01") },
    });
    const csv = "employeeCode,effectiveFrom,ctcAnnual,basicMonthly,hraMonthly,specialAllowance\nONLYB,2025-04-01,600000,20000,8000,22000\n";
    const { headers, records } = parseCsvRecords(csv);
    const plan = await withTenant(A.companyId, (db) =>
      IMPORTERS.salary.plan({ headers, records, ctx: { actor: A.ctx, params: {} }, db })
    );
    expect(plan.valid).toBe(0);
    expect(plan.issues[0].messages.join(" ")).toMatch(/No employee with code ONLYB/);
  });

  it("an employee upload in A treats B's login emails as already registered", async () => {
    const csv =
      "employeeCode,firstName,lastName,email,dateOfJoining,state\nEMP777,Some,One,emp1@bravo.test,2025-01-01,Karnataka\n";
    const { headers, records } = parseCsvRecords(csv);
    const plan = await withTenant(A.companyId, (db) =>
      IMPORTERS.employees.plan({ headers, records, ctx: { actor: A.ctx, params: {} }, db })
    );
    expect(plan.valid).toBe(0);
    expect(plan.issues[0].messages.join(" ")).toMatch(/already registered/);
  });

  it("a committed import lands only in the importing company", async () => {
    const csv = "employeeCode,leaveType,balance\nEMP001,Casual Leave,7.5\n";
    const { headers, records } = parseCsvRecords(csv);
    await withTenant(A.companyId, async (db) => {
      const plan = await IMPORTERS["leave-balances"].plan({ headers, records, ctx: { actor: A.ctx, params: {} }, db });
      expect(plan.valid).toBe(1);
      await plan.commit();
    });
    expect(await owner.leaveLedger.count({ where: { companyId: A.companyId } })).toBeGreaterThan(0);
    expect(await owner.leaveLedger.count({ where: { companyId: B.companyId } })).toBe(0);
  });

  it("a failed import rolls back completely", async () => {
    const before = await owner.employee.count({ where: { companyId: A.companyId } });
    await expect(
      withTenant(A.companyId, async (db) => {
        await createEmployeeWithLogin(db, A.ctx, {
          employeeCode: "ROLLBACK1",
          firstName: "Will",
          lastName: "Vanish",
          email: "vanish@alpha.test",
          dateOfJoining: new Date("2025-01-01"),
          state: "KA",
          passwordHash: "x",
        });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await owner.employee.count({ where: { companyId: A.companyId } })).toBe(before);
  });
});
