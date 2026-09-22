import Link from "next/link";
import { withPlatform } from "@/server/tenancy/db";
import { hashInviteToken } from "@/server/companies/provision";
import { Alert, buttonClass } from "@/components/ui";
import { AcceptForm } from "./accept-form";

export default async function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const invitation = await withPlatform((db) =>
    db.invitation.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      include: { user: { select: { email: true, name: true } }, company: { select: { name: true, status: true } } },
    })
  );

  const valid =
    invitation && !invitation.acceptedAt && invitation.expiresAt > new Date() && invitation.company.status !== "SUSPENDED";

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="fade-up w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-xl font-bold text-white">
            ₹
          </span>
          <span className="text-lg font-semibold text-ink">Payroll Portal</span>
        </div>

        {valid ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Welcome{invitation.user.name ? `, ${invitation.user.name.split(" ")[0]}` : ""}</h1>
            <p className="mt-1 text-sm text-ink-soft">
              You&apos;ve been invited to manage <b className="font-medium text-ink">{invitation.company.name}</b> as{" "}
              {invitation.user.email}. Choose a password to activate your account.
            </p>
            <AcceptForm token={token} />
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">This link can&apos;t be used</h1>
            <div className="mt-4">
              <Alert tone="warning">
                The invitation has expired, was already used, or was replaced by a newer one. Ask your administrator
                for a fresh link.
              </Alert>
            </div>
            <Link href="/login" className={`${buttonClass("secondary")} mt-6`}>
              Go to sign in
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
