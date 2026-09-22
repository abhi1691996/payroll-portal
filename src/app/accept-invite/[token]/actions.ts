"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { withPlatform } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { hashInviteToken } from "@/server/companies/provision";
import { passwordSchema } from "@/lib/validations/company";

export interface AcceptState {
  error?: string;
}

/** Sets the invited user's password, activates the account and consumes the invitation (single use). */
export async function acceptInvitation(token: string, _prev: AcceptState, formData: FormData): Promise<AcceptState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const check = passwordSchema.safeParse(password);
  if (!check.success) return { error: check.error.issues[0].message };
  if (password !== confirm) return { error: "The two passwords don't match" };

  const passwordHash = await bcrypt.hash(password, 10);

  const outcome = await withPlatform(async (db) => {
    const invitation = await db.invitation.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      include: { user: true, company: { select: { status: true } } },
    });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) return "invalid" as const;
    if (invitation.company.status === "SUSPENDED") return "invalid" as const;

    await db.user.update({ where: { id: invitation.userId }, data: { passwordHash, status: "ACTIVE" } });
    await db.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
    await audit(db, {
      userId: invitation.userId,
      email: invitation.user.email,
      companyId: invitation.companyId,
      ip: null,
      userAgent: null,
    }, { module: "auth", action: "invite.accept", entityType: "User", entityId: invitation.userId });
    return "ok" as const;
  });

  if (outcome === "invalid") return { error: "This invitation link is no longer valid. Ask for a new one." };
  redirect("/login?accepted=1");
}
