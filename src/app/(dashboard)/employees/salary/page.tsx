import Link from "next/link";
import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { SEPARATED_STATUSES } from "@/server/employees/lifecycle";
import { withTenant } from "@/server/tenancy/db";
import { readLines } from "@/server/salary/service";
import { fmtDate, inr, inrCompact } from "@/lib/format";
import { BulkImport } from "@/components/bulk-import";
import { BulkPanel } from "@/components/bulk-panel";
import {
  Alert,
  Avatar,
  Badge,
  EmptyRow,
  LinkButton,
  PageHeader,
  StatCard,
  StatusBadge,
  Table,
  TableCard,
  Tabs,
  Td,
  Th,
  Tr,
} from "@/components/ui";

export default async function SalariesPage({
  searchParams,
}: {
  searchParams: Promise<{ bulk?: string }>;
}) {
  const ctx = await requirePermission("employee.salary.read", "COMPANY");
  const { bulk } = await searchParams;
  const canUpload = can(ctx, "employee.salary.write", "COMPANY");
  const canConfigure = can(ctx, "settings.write", "COMPANY");
  const canSeeSeparated = can(ctx, "employee.read", "COMPANY");

  const { employees, components } = await withTenant(ctx.companyId, async (db) => ({
    employees: await db.employee.findMany({
      where: { status: { notIn: SEPARATED_STATUSES } },
      orderBy: { employeeCode: "asc" },
      include: { salaries: { orderBy: { effectiveFrom: "desc" }, take: 1, include: { template: { select: { name: true } } } } },
    }),
    components: await db.salaryComponent.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" }, select: { code: true, name: true } }),
  }));

  const withSalary = employees.filter((e) => e.salaries.length > 0);
  const missing = employees.filter((e) => e.salaries.length === 0);
  const totalCtc = withSalary.reduce((sum, e) => sum + Number(e.salaries[0].ctcAnnual), 0);
  const totalGross = withSalary.reduce((sum, e) => sum + Number(e.salaries[0].grossMonthly), 0);

  return (
    <div>
      <PageHeader
        title="Salaries"
        description="Each employee's current pay, built from your own salary structures. Revisions are versioned — earlier salaries are kept so past payslips never change."
        actions={
          <>
            {canConfigure && (
              <LinkButton href="/settings/salary" variant="secondary" icon="settings">
                Salary structures
              </LinkButton>
            )}
            <LinkButton href="/bulk/salary/export.csv" variant="secondary" icon="download" download>
              Export
            </LinkButton>
          </>
        }
      />

      <Tabs
        items={[
          { href: "/employees", label: "Directory", active: false },
          { href: "/employees/salary", label: "Salaries", active: true, count: withSalary.length },
          ...(canSeeSeparated ? [{ href: "/employees/separated", label: "Separated", active: false }] : []),
        ]}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="With salary set" value={withSalary.length} hint={`of ${employees.length} active`} icon="check" tone="green" />
        <StatCard
          label="Missing salary"
          value={missing.length}
          hint={missing.length ? "Skipped by payroll until set" : "All set"}
          icon="warning"
          tone={missing.length ? "amber" : "slate"}
        />
        <StatCard label="Monthly gross payout" value={inrCompact(totalGross)} hint={`${inrCompact(totalCtc)} annual CTC`} icon="payroll" tone="brand" />
      </div>

      {missing.length > 0 && (
        <div className="mb-6">
          <Alert tone="warning">
            <p className="font-medium">
              {missing.length} employee{missing.length === 1 ? " has" : "s have"} no salary yet
            </p>
            <p className="mt-0.5">
              Payroll silently skips anyone without one: {missing.slice(0, 6).map((e) => e.employeeCode).join(", ")}
              {missing.length > 6 ? ` and ${missing.length - 6} more` : ""}.
            </p>
          </Alert>
        </div>
      )}

      {canUpload && (
        <BulkPanel
          title="Bulk upload salaries"
          subtitle="Set CTC and pay components for many employees from one CSV — the template matches YOUR salary structure."
          defaultOpen={bulk === "1" || (withSalary.length === 0 && employees.length > 0)}
        >
          <BulkImport
            kind="salary"
            unit="salary"
            title="Import salaries from CSV"
            description="One row per employee per revision. Pick a structure and CTC and the components are worked out; add a component's code as a column to set an exact amount."
            columnsHint={`Required: employeeCode, effectiveFrom, ctcAnnual. Optional: structure (name), employerPfOptIn (YES/NO), taxRegime (NEW/OLD), and any of your components: ${components.map((c) => c.code).join(", ") || "none yet"}.`}
            templates={[{ label: "Download template", href: "/bulk/salary/template.csv" }]}
            exports={[{ label: "Export current salaries", href: "/bulk/salary/export.csv" }]}
          >
            <ul className="grid gap-x-8 gap-y-1.5 text-sm text-ink-soft sm:grid-cols-2">
              <li>• The template lists <b className="font-medium text-ink">your</b> components as columns.</li>
              <li>• Dates: 2025-04-01 or 01/04/2025 (day first).</li>
              <li>• effectiveFrom must be later than the employee&apos;s current salary.</li>
              <li>• Leave a component blank to let the structure work it out.</li>
            </ul>
          </BulkImport>
        </BulkPanel>
      )}

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Employee</Th>
              <Th>Effective from</Th>
              <Th>Structure</Th>
              <Th align="right">CTC / yr</Th>
              <Th align="right">Gross / month</Th>
              <Th>Components</Th>
              <Th>Regime</Th>
              <Th>PF</Th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const s = e.salaries[0];
              const name = `${e.firstName} ${e.lastName}`;
              return (
                <Tr key={e.id}>
                  <Td>
                    <Link href={`/employees/${e.id}`} className="flex items-center gap-3">
                      <Avatar name={name} size="sm" />
                      <span>
                        <span className="block font-medium text-ink hover:text-brand-700">{name}</span>
                        <span className="block font-mono text-xs text-ink-muted">{e.employeeCode}</span>
                      </span>
                    </Link>
                  </Td>
                  {s ? (
                    <>
                      <Td className="whitespace-nowrap text-ink-soft">{fmtDate(s.effectiveFrom)}</Td>
                      <Td className="text-ink-soft">{s.template?.name ?? "—"}</Td>
                      <Td align="right" numeric className="font-medium">{inr(s.ctcAnnual)}</Td>
                      <Td align="right" numeric className="font-semibold">{inr(s.grossMonthly)}</Td>
                      <Td>
                        <div className="flex max-w-md flex-wrap gap-1.5">
                          {readLines(s.lines).map((l) => (
                            <span key={l.code} className="rounded-md bg-canvas px-2 py-0.5 text-xs text-ink-soft">
                              {l.name} <b className="font-medium text-ink">{inr(l.monthlyAmount)}</b>
                            </span>
                          ))}
                        </div>
                      </Td>
                      <Td>
                        <StatusBadge status={e.taxRegime} />
                      </Td>
                      <Td>{s.employerPfOptIn ? <Badge tone="green">Yes</Badge> : <Badge>No</Badge>}</Td>
                    </>
                  ) : (
                    <Td className="text-ink-muted">
                      <span className="flex items-center gap-3">
                        <Badge tone="amber">Not set</Badge>
                        <Link href={`/employees/${e.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                          Set salary
                        </Link>
                      </span>
                    </Td>
                  )}
                  {!s && <td colSpan={6} className="border-b border-line/70" />}
                </Tr>
              );
            })}
            {employees.length === 0 && <EmptyRow colSpan={8}>No employees yet — add employees first.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
