import { requireSuperAdmin } from "@/server/rbac/guard";
import { withPlatform } from "@/server/tenancy/db";
import { fmtDate } from "@/lib/format";
import Link from "next/link";
import {
  EmptyRow,
  LinkButton,
  PageHeader,
  StatCard,
  StatusBadge,
  Table,
  TableCard,
  Td,
  Th,
  Tr,
} from "@/components/ui";

export default async function PlatformDashboardPage() {
  await requireSuperAdmin();
  const now = new Date();

  const { companies, employeeCounts, runsThisMonth } = await withPlatform(async (db) => ({
    companies: await db.company.findMany({
      orderBy: { createdAt: "desc" },
      include: { subscriptions: { include: { plan: true }, orderBy: { createdAt: "desc" }, take: 1 } },
    }),
    employeeCounts: await db.employee.groupBy({ by: ["companyId"], _count: { _all: true } }),
    runsThisMonth: await db.payrollRun.count({ where: { month: now.getMonth() + 1, year: now.getFullYear() } }),
  }));

  const employeesByCompany = new Map(employeeCounts.map((e) => [e.companyId, e._count._all]));
  const totalEmployees = employeeCounts.reduce((sum, e) => sum + e._count._all, 0);
  const byStatus = (s: string) => companies.filter((c) => c.status === s).length;

  return (
    <div>
      <PageHeader
        title="Platform dashboard"
        description="All client companies at a glance."
        actions={
          <LinkButton href="/platform/clients/new" icon="plus">
            Add client
          </LinkButton>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Total clients" value={companies.length} icon="building" tone="brand" />
        <StatCard label="Active" value={byStatus("ACTIVE")} icon="check" tone="green" />
        <StatCard label="Trial" value={byStatus("TRIAL")} icon="clock" tone="amber" />
        <StatCard label="Suspended" value={byStatus("SUSPENDED")} icon="warning" tone="red" />
        <StatCard label="Employees" value={totalEmployees} icon="users" tone="violet" hint={`${runsThisMonth} payroll runs this month`} />
      </div>

      <h2 className="mb-3 mt-8 text-base font-semibold text-ink">Clients</h2>
      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Company</Th>
              <Th>State</Th>
              <Th>Plan</Th>
              <Th align="right">Employees</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => (
              <Tr key={c.id}>
                <Td className="font-medium">
                  <Link href={`/platform/clients/${c.id}`} className="hover:text-brand-700">
                    {c.name}
                  </Link>
                </Td>
                <Td className="text-ink-soft">{c.state}</Td>
                <Td className="text-ink-soft">{c.subscriptions[0]?.plan.name ?? "—"}</Td>
                <Td align="right" numeric>{employeesByCompany.get(c.id) ?? 0}</Td>
                <Td>
                  <StatusBadge status={c.status} />
                </Td>
                <Td className="whitespace-nowrap text-ink-soft">{fmtDate(c.createdAt)}</Td>
              </Tr>
            ))}
            {companies.length === 0 && <EmptyRow colSpan={6}>No clients yet — add your first one.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
