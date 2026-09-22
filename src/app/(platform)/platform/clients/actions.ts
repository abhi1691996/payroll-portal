"use server";

import { revalidatePath } from "next/cache";
import { assertSuperAdmin } from "@/server/rbac/guard";
import { withPlatform } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { provisionCompany, generateInviteToken, INVITE_TTL_DAYS } from "@/server/companies/provision";
import { getOrigin } from "@/server/http/origin";
import { findTakenEmails } from "@/server/users/email-registry";
import { clientSchemaChecked } from "@/lib/validations/company";
import type { ClientActionState } from "./state";

const inviteLink = (origin: string, token: string) => `${origin}/accept-invite/${token}`;

/** Creates a client company, its initial Company Admin (invited, no password yet) and returns the one-time invite link. */
export async function createClient(_prev: ClientActionState, formData: FormData): Promise<ClientActionState> {
  const ctx = await assertSuperAdmin();

  const raw = Object.fromEntries(formData.entries());
  const parsed = clientSchemaChecked.safeParse({
    ...raw,
    pan: String(raw.pan ?? "").toUpperCase().trim(),
    gstin: String(raw.gstin ?? "").toUpperCase().trim(),
    cin: String(raw.cin ?? "").toUpperCase().trim(),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return { status: "error", message: "Please fix the highlighted fields.", fieldErrors };
  }
  const d = parsed.data;

  if ((await findTakenEmails([d.adminEmail])).size > 0) {
    return { status: "error", message: "That admin email is already registered.", fieldErrors: { adminEmail: "Already registered — use a different email" } };
  }

  try {
    const result = await withPlatform(
      async (db) => {
        if (!(await db.plan.findUnique({ where: { code: d.planCode }, select: { id: true } }))) {
          throw new Error("Unknown plan");
        }
        const created = await provisionCompany(
          db,
          {
            company: {
              name: d.name,
              legalName: d.legalName || undefined,
              pan: d.pan || undefined,
              gstin: d.gstin || undefined,
              cin: d.cin || undefined,
              companyType: d.companyType || undefined,
              industry: d.industry || undefined,
              address: d.address,
              state: d.state,
              financialYearStart: d.financialYearStart,
              payrollFrequency: "MONTHLY",
              status: "TRIAL",
            },
            admin: { name: d.adminName, email: d.adminEmail, mobile: d.adminMobile || undefined },
            planCode: d.planCode,
          },
          ctx.userId
        );
        await audit(db, { ...ctx, companyId: created.companyId }, {
          module: "platform",
          action: "client.create",
          entityType: "Company",
          entityId: created.companyId,
          newValue: { name: d.name, state: d.state, plan: d.planCode, adminEmail: d.adminEmail },
        });
        return created;
      },
      { timeout: 30_000 }
    );

    revalidatePath("/platform");
    revalidatePath("/platform/clients");
    return {
      status: "created",
      companyId: result.companyId,
      companyName: d.name,
      adminEmail: d.adminEmail,
      inviteLink: inviteLink(await getOrigin(), result.inviteToken!),
      expiresInDays: INVITE_TTL_DAYS,
    };
  } catch (err) {
    console.error("[create-client]", err);
    return { status: "error", message: "Couldn't create the client. Nothing was saved — please try again." };
  }
}

/** Suspending blocks every user of the company from signing in (and from any active session) immediately. */
export async function setClientStatus(companyId: string, next: "ACTIVE" | "SUSPENDED") {
  const ctx = await assertSuperAdmin();

  await withPlatform(async (db) => {
    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) throw new Error("Client not found");
    if (company.status === next) return;
    await db.company.update({ where: { id: companyId }, data: { status: next } });
    await audit(db, { ...ctx, companyId }, {
      module: "platform",
      action: next === "SUSPENDED" ? "client.suspend" : "client.activate",
      entityType: "Company",
      entityId: companyId,
      oldValue: { status: company.status },
      newValue: { status: next },
    });
  });

  revalidatePath(`/platform/clients/${companyId}`);
  revalidatePath("/platform/clients");
  revalidatePath("/platform");
}

/**
 * Issues a fresh invite link for a Company Admin who has NOT accepted yet. Deliberately refused once
 * the admin has set a password: a platform user must never be able to mint a link that takes over
 * an active customer account.
 */
export async function reissueAdminInvite(companyId: string): Promise<ClientActionState> {
  const ctx = await assertSuperAdmin();

  try {
    const token = await withPlatform(async (db) => {
      const admin = await db.user.findFirst({
        where: { companyId, userRoles: { some: { role: { key: "COMPANY_ADMIN" } } } },
        orderBy: { createdAt: "asc" },
      });
      if (!admin) throw new Error("This company has no admin");
      if (admin.status !== "INVITED") throw new Error("The admin has already set a password");

      await db.invitation.deleteMany({ where: { userId: admin.id, acceptedAt: null } });
      const { token, tokenHash } = generateInviteToken();
      await db.invitation.create({
        data: {
          companyId,
          userId: admin.id,
          tokenHash,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
          createdById: ctx.userId,
        },
      });
      await audit(db, { ...ctx, companyId }, {
        module: "platform",
        action: "client.invite.reissue",
        entityType: "User",
        entityId: admin.id,
        newValue: { adminEmail: admin.email },
      });
      return token;
    });

    revalidatePath(`/platform/clients/${companyId}`);
    return {
      status: "created",
      companyId,
      inviteLink: inviteLink(await getOrigin(), token),
      expiresInDays: INVITE_TTL_DAYS,
    };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Couldn't create a new invite" };
  }
}
