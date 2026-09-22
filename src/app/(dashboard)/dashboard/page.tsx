import Link from "next/link";
import { requireTenant } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { inr, inrCompact } from "@/lib/format";
import { Icon, type IconName } from "@/components/icons";
import type { PermissionKey } from "@/server/rbac/permissions";
import { Card, CardHeader, LinkButton, PageHeader, StatCard, StatusBadge } from "@/components/ui";
import { ROSTER_STATUSES, SEPARATED_STATUSES } from "@/server/employees/lifecycle";

const QUICK_ACTIONS: { href: string; label: string; hint: string; icon: IconName; permission: PermissionKey }[] = [
  { href: "/employees?bulk=1#bulk-upload", label: "Upload employees", hint: "Onboard many at once", icon: "users", permission: "employee.import" },
  { href: "/employees/salary?bulk=1#bulk-upload", label: "Upload salaries", hint: "CTC & structure", icon: "payroll", permission: "employee.salary.write" },
  { href: "/attendance?bulk=1#bulk-upload", label: "Upload attendance", hint: "Monthly grid or daily list", icon: "attendance", permission: "attendance.import" },
  { href: "/leave?bulk=1#bulk-upload", label: "Upload leave", hint: "History & balances", icon: "leave", permission: "leave.manage" },
];

export default async function DashboardPage() {
  const ctx = await requireTenant();
  // Company-wide view for anyone who can see all employees; everyone else gets the personal view.
  const isAdmin = can(ctx, "employee.read", "COMPANY");

  /* ------------------------------ Employee view ----------------------------- */
  if (!isAdmin) {
    const { employee, latestPayslip, pendingLeave } = await withTenant(ctx.companyId, async (db) => {
      const employee = ctx.employeeId
        ? await db.employee.findUnique({ where: { id: ctx.employeeId } })
        : null;
      const latestPayslip = employee
        ? await db.payslip.findFirst({
            where: { employeeId: employee.id },
            orderBy: [{ payrollRun: { year: "desc" } }, { payrollRun: { month: "desc" } }],
            include: { payrollRun: true },
          })
        : null;
      const pendingLeave = employee
        ? await db.leaveRequest.count({ where: { employeeId: employee.id, status: "PENDING" } })
        : 0;
      return { employee, latestPayslip, pendingLeave };
    });

    return (
      <div className="max-w-4xl">
        <PageHeader
          title={`Welcome, ${employee?.firstName ?? ctx.name ?? ctx.email}`}
          description="Your pay, attendance and leave in one place."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Latest net pay"
            value={latestPayslip ? inr(latestPayslip.netPay) : "—"}
            hint={
              latestPayslip
                ? monthLabel(latestPayslip.payrollRun.year, latestPayslip.payrollRun.month)
                : "No payslips yet"
            }
            icon="payslip"
            tone="green"
            href={latestPayslip ? `/payslips/${latestPayslip.id}` : "/payslips"}
          />
          <StatCard
            label="Pending leave requests"
            value={pendingLeave}
            hint="Tap to manage leave"
            icon="leave"
            tone="amber"
            href="/leave"
          />
          {employee && (
            <StatCard
              label="My profile"
              value={{ ACTIVE: "Active", ON_LEAVE: "On leave", SUSPENDED: "Suspended", RESIGNED: "Resigned", TERMINATED: "Terminated" }[employee.status]}
              hint="Resignation, details"
              icon="users"
              tone="brand"
              href={`/employees/${employee.id}`}
            />
          )}
        </div>
      </div>
    );
  }

  /* -------------------------------- Admin view ------------------------------ */
  // Payroll and salary figures are only shown to people who hold those permissions (an HR manager
  // sees headcount and leave, not payroll totals).
  const showPayroll = can(ctx, "payroll.read", "COMPANY");
  const showSalary = can(ctx, "employee.salary.read", "COMPANY");
  const { headcount, pendingLeaveCount, missingSalary, runs, departments, totals } = await withTenant(
    ctx.companyId,
    async (db) => {
      const [headcount, pendingLeaveCount, missingSalary, runs, departments] = await Promise.all([
        db.employee.count({ where: { status: { in: ROSTER_STATUSES } } }),
        db.leaveRequest.count({ where: { status: "PENDING" } }),
        showSalary
          ? db.employee.count({ where: { status: { notIn: SEPARATED_STATUSES }, salaries: { none: {} } } })
          : Promise.resolve(0),
        showPayroll
          ? db.payrollRun.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }], take: 6 })
          : Promise.resolve([]),
        db.employee.groupBy({
          by: ["department"],
          where: { status: { notIn: SEPARATED_STATUSES } },
          _count: { _all: true },
          orderBy: { _count: { department: "desc" } },
        }),
      ]);
      const totals = runs.length
        ? await db.payslip.groupBy({
            by: ["payrollRunId"],
            where: { payrollRunId: { in: runs.map((r) => r.id) } },
            _sum: { netPay: true },
            _count: { _all: true },
          })
        : [];
      return { headcount, pendingLeaveCount, missingSalary, runs, departments, totals };
    }
  );
  const totalByRun = new Map(totals.map((t) => [t.payrollRunId, Number(t._sum.netPay ?? 0)]));
  const latestRun = runs[0];
  const maxTotal = Math.max(1, ...runs.map((r) => totalByRun.get(r.id) ?? 0));
  const totalPeople = departments.reduce((sum, d) => sum + d._count._all, 0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="A snapshot of your people and payroll."
        actions={
          can(ctx, "payroll.run", "COMPANY") ? (
            <LinkButton href="/payroll/runs" icon="payroll">
              Run payroll
            </LinkButton>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active employees" value={headcount} icon="users" tone="brand" href="/employees" hint="View directory" />
        <StatCard
          label="Pending leave approvals"
          value={pendingLeaveCount}
          icon="clock"
          tone={pendingLeaveCount ? "amber" : "slate"}
          href="/leave"
          hint={pendingLeaveCount ? "Needs review" : "All caught up"}
        />
        {showSalary && (
        <StatCard
          label="Missing salary structure"
          value={missingSalary}
          icon="warning"
          tone={missingSalary ? "red" : "green"}
          href="/employees/salary"
          hint={missingSalary ? "Skipped by payroll" : "Everyone is set"}
        />
        )}
        {showPayroll && (
        <StatCard
          label="Latest payroll"
          value={latestRun ? inrCompact(totalByRun.get(latestRun.id) ?? 0) : "—"}
          icon="payroll"
          tone="green"
          href={latestRun ? `/payroll/runs/${latestRun.id}` : "/payroll/runs"}
          hint={latestRun ? monthLabel(latestRun.year, latestRun.month) : "No runs yet"}
        />
        )}
      </div>

      <section className="mt-8" aria-labelledby="bulk-heading">
        <h2 id="bulk-heading" className="mb-3 text-base font-semibold text-ink">
          Bulk upload
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {QUICK_ACTIONS.filter((a) => can(ctx, a.permission, "COMPANY")).map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="fade-up group flex items-center gap-3 rounded-2xl border border-dashed border-brand-300 bg-brand-50/50 p-4 transition hover:border-brand-500 hover:bg-brand-50"
            >
              <span className="grid size-10 place-items-center rounded-xl bg-brand-600 text-white shadow-sm shadow-brand-600/30">
                <Icon name={a.icon} className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-brand-900">{a.label}</span>
                <span className="block truncate text-xs text-brand-800/70">{a.hint}</span>
              </span>
              <Icon name="arrow-right" className="size-4 text-brand-600 transition group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-5">
        {showPayroll && (
        <Card className="lg:col-span-3">
          <CardHeader
            title="Recent payroll runs"
            description="Net pay per month"
            action={
              <Link href="/payroll/runs" className="text-sm font-medium text-brand-700 hover:underline">
                All runs
              </Link>
            }
          />
          {runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">No payroll runs yet.</p>
          ) : (
            <ul className="space-y-3">
              {runs.map((run) => {
                const total = totalByRun.get(run.id) ?? 0;
                return (
                  <li key={run.id}>
                    <Link href={`/payroll/runs/${run.id}`} className="group block">
                      <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                        <span className="flex items-center gap-2 font-medium text-ink group-hover:text-brand-700">
                          {monthLabel(run.year, run.month)}
                          <StatusBadge status={run.status} />
                        </span>
                        <span className="tabular-nums text-ink-soft">{inr(total)}</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-canvas">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
                          style={{ width: `${Math.max(3, (total / maxTotal) * 100)}%` }}
                        />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        )}

        <Card className={showPayroll ? "lg:col-span-2" : "lg:col-span-5"}>
          <CardHeader title="Headcount by department" description={`${totalPeople} people`} />
          {departments.length === 0 ? (
            <p className="text-sm text-ink-muted">No employees yet.</p>
          ) : (
            <ul className="space-y-3">
              {departments.map((d) => (
                <li key={d.department ?? "none"}>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-ink">{d.department ?? "Unassigned"}</span>
                    <span className="tabular-nums text-ink-soft">{d._count._all}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-canvas">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${(d._count._all / Math.max(1, totalPeople)) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
