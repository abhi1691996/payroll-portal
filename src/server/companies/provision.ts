import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { hashPassword } from "@/lib/password";
import { SYSTEM_ROLES } from "@/server/rbac/roles";
import { ensureCompanyDefaults } from "./defaults";

type Db = Prisma.TransactionClient | PrismaClient;

export const INVITE_TTL_DAYS = 7;
export const TRIAL_DAYS = 14;

export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Copies the built-in role templates into a company. Returns role ids by key. */
export async function seedSystemRoles(db: Db, companyId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const template of SYSTEM_ROLES) {
    const role = await db.role.upsert({
      where: { companyId_key: { companyId, key: template.key } },
      create: { companyId, key: template.key, name: template.name, description: template.description, isSystem: true },
      update: {},
    });
    ids.set(template.key, role.id);
    await db.rolePermission.createMany({
      data: Object.entries(template.grants).map(([permissionKey, scope]) => ({
        roleId: role.id,
        companyId,
        permissionKey,
        scope: scope!,
      })),
      skipDuplicates: true,
    });
  }
  return ids;
}

export interface ProvisionInput {
  company: {
    name: string;
    legalName?: string;
    pan?: string;
    tan?: string;
    gstin?: string;
    cin?: string;
    companyType?: string;
    industry?: string;
    address: string;
    state: string;
    financialYearStart?: number;
    payrollFrequency?: string;
    pfEstablishmentId?: string;
    esiEstablishmentId?: string;
    payCycleStartDay?: number;
    status?: "TRIAL" | "ACTIVE";
  };
  admin: {
    name: string;
    email: string;
    mobile?: string;
    /** Provide for seeds/tests. Omit to create an INVITED admin who sets their own password. */
    password?: string;
  };
  planCode?: string;
  /** Existing id to keep (used when migrating legacy data). */
  companyId?: string;
}

export interface ProvisionResult {
  companyId: string;
  adminUserId: string;
  roleIds: Map<string, string>;
  /** Present only when the admin was invited (no password supplied). Show it once; only its hash is stored. */
  inviteToken?: string;
}

export type CompanyInput = ProvisionInput["company"];

/**
 * The tenant itself: company row, trial subscription and the six system roles. Split out so data
 * migrations can create a company and bring their own users (preserving ids and password hashes).
 */
export async function createCompanyShell(
  db: Db,
  company: CompanyInput,
  planCode = "TRIAL",
  companyId?: string,
  /** Seed the default statutory rates and leave types. Data migrations bring their own. */
  withDefaults = true
): Promise<{ companyId: string; roleIds: Map<string, string> }> {
  const created = await db.company.create({
    data: {
      ...(companyId ? { id: companyId } : {}),
      ...company,
      status: company.status ?? "TRIAL",
    },
  });

  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (plan) {
    const now = new Date();
    await db.subscription.create({
      data: {
        companyId: created.id,
        planId: plan.id,
        status: "TRIAL",
        trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000),
        currentPeriodStart: now,
      },
    });
  }

  const roleIds = await seedSystemRoles(db, created.id);

  // Starting rules (salary components, shift, working week, leave, approvals, statutory rates). All of it
  // is editable company data; see ./defaults.ts.
  if (withDefaults) await ensureCompanyDefaults(db, created.id);
  return { companyId: created.id, roleIds };
}

/**
 * Creates a company and everything it needs to start: subscription, the six system roles, and the
 * first COMPANY_ADMIN login. Must run with platform privileges (`withPlatform`) because it creates
 * the tenant itself.
 */
export async function provisionCompany(
  db: Db,
  input: ProvisionInput,
  createdById?: string
): Promise<ProvisionResult> {
  const { companyId, roleIds } = await createCompanyShell(db, input.company, input.planCode, input.companyId);

  const invited = !input.admin.password;
  // An invited admin gets an unguessable placeholder hash until they accept the invitation.
  const passwordHash = await hashPassword(input.admin.password ?? randomBytes(32).toString("hex"));
  const admin = await db.user.create({
    data: {
      companyId,
      email: input.admin.email.trim().toLowerCase(),
      name: input.admin.name,
      mobile: input.admin.mobile,
      passwordHash,
      status: invited ? "INVITED" : "ACTIVE",
    },
  });
  await db.userRole.create({
    data: { userId: admin.id, roleId: roleIds.get("COMPANY_ADMIN")!, companyId },
  });

  let inviteToken: string | undefined;
  if (invited) {
    const { token, tokenHash } = generateInviteToken();
    inviteToken = token;
    await db.invitation.create({
      data: {
        companyId,
        userId: admin.id,
        tokenHash,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        createdById,
      },
    });
  }

  return { companyId, adminUserId: admin.id, roleIds, inviteToken };
}
