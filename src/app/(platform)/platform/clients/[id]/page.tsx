import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/server/rbac/guard";
import { withPlatform } from "@/server/tenancy/db";
import { fmtDate } from "@/lib/format";
import { Alert, Card, CardHeader, PageHeader, StatCard, StatusBadge } from "@/components/ui";
import { ReissueInvite, StatusControl } from "./client-controls";

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value || "—"}</dd>
    </div>
  );
}

const MONTH = (n: number) => new Date(2000, n - 1, 1).toLocaleDateString("en-IN", { month: "long" });

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSuperAdmin();
  const { id } = await params;

  const data = await withPlatform(async (db) => {
    const company = await db.company.findUnique({
      where: { id },
      include: { subscriptions: { include: { plan: true }, orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!company) return null;
    const admin = await db.user.findFirst({
      where: { companyId: id, userRoles: { some: { role: { key: "COMPANY_ADMIN" } } } },
      orderBy: { createdAt: "asc" },
    });
    const [employees, runs, latestRun, activity] = await Promise.all([
      db.employee.count({ where: { companyId: id } }),
      db.payrollRun.count({ where: { companyId: id } }),
      db.payrollRun.findFirst({ where: { companyId: id }, orderBy: [{ year: "desc" }, { month: "desc" }] }),
      db.auditLog.findMany({ where: { companyId: id }, orderBy: { createdAt: "desc" }, take: 8 }),
    ]);
    return { company, admin, employees, runs, latestRun, activity };
  });
  if (!data) notFound();
  const { company, admin, employees, runs, latestRun, activity } = data;
  const sub = company.subscriptions[0];

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        back={{ href: "/platform/clients", label: "Clients" }}
        title={
          <span className="flex items-center gap-3">
            {company.name}
            <StatusBadge status={company.status} />
          </span>
        }
        description={company.legalName && company.legalName !== company.name ? company.legalName : undefined}
        actions={<StatusControl companyId={company.id} status={company.status} name={company.name} />}
      />

      {company.status === "SUSPENDED" && (
        <Alert tone="warning">This client is suspended: none of its users can sign in. Their data is untouched.</Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Employees" value={employees} icon="users" tone="brand" hint={sub?.plan.maxEmployees ? `Plan limit ${sub.plan.maxEmployees}` : "No plan limit"} />
        <StatCard label="Payroll runs" value={runs} icon="payroll" tone="green" hint={latestRun ? `Latest: ${MONTH(latestRun.month)} ${latestRun.year} (${latestRun.status.toLowerCase()})` : "None yet"} />
        <StatCard label="Plan" value={sub?.plan.name ?? "—"} icon="shield" tone="violet" hint={sub?.trialEndsAt ? `Trial ends ${fmtDate(sub.trialEndsAt)}` : sub?.status} />
      </div>

      <Card>
        <CardHeader title="Company" />
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Type" value={company.companyType} />
          <Detail label="Industry" value={company.industry} />
          <Detail label="State" value={company.state} />
          <Detail label="PAN" value={company.pan} />
          <Detail label="GSTIN" value={company.gstin} />
          <Detail label="CIN" value={company.cin} />
          <Detail label="Financial year starts" value={MONTH(company.financialYearStart)} />
          <Detail label="Payroll frequency" value={company.payrollFrequency === "MONTHLY" ? "Monthly" : company.payrollFrequency} />
          <Detail label="Created" value={fmtDate(company.createdAt)} />
          <div className="sm:col-span-2 lg:col-span-3">
            <Detail label="Registered address" value={company.address} />
          </div>
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Company Admin"
          description={admin?.status === "INVITED" ? "Hasn't accepted the invitation yet." : undefined}
        />
        {admin ? (
          <div className="space-y-4">
            <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
              <Detail label="Name" value={admin.name} />
              <Detail label="Email" value={admin.email} />
              <Detail label="Mobile" value={admin.mobile} />
              <Detail label="Status" value={admin.status === "INVITED" ? "Invitation pending" : admin.status === "ACTIVE" ? "Active" : "Disabled"} />
              <Detail label="Last sign-in" value={admin.lastLoginAt ? fmtDate(admin.lastLoginAt) : "Never"} />
            </dl>
            {admin.status === "INVITED" ? (
              <ReissueInvite companyId={company.id} />
            ) : (
              <p className="text-sm text-ink-muted">
                The admin has set their own password. For security, platform administrators can&apos;t issue links that
                would change an active customer&apos;s password.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">This company has no admin user.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent activity" description="From the audit log." />
        {activity.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-line/70 text-sm">
            {activity.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-4 py-2.5">
                <span>
                  <span className="font-medium text-ink">{a.action}</span>
                  <span className="text-ink-muted"> · {a.actorEmail ?? "system"}</span>
                </span>
                <span className="whitespace-nowrap text-xs text-ink-muted">{a.createdAt.toLocaleString("en-IN")}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
