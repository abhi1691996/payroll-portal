import Link from "next/link";
import type { CompanyStatus, Prisma } from "@prisma/client";
import { requireSuperAdmin } from "@/server/rbac/guard";
import { withPlatform } from "@/server/tenancy/db";
import { fmtDate } from "@/lib/format";
import { Icon } from "@/components/icons";
import {
  EmptyRow,
  LinkButton,
  PageHeader,
  StatusBadge,
  Table,
  TableCard,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
} from "@/components/ui";

const STATUSES: CompanyStatus[] = ["TRIAL", "ACTIVE", "SUSPENDED"];

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireSuperAdmin();
  const { q, status } = await searchParams;
  const query = q?.trim() ?? "";
  const statusFilter = STATUSES.find((s) => s === status);

  const where: Prisma.CompanyWhereInput = {
    ...(statusFilter && { status: statusFilter }),
    ...(query && { OR: [{ name: { contains: query, mode: "insensitive" } }, { legalName: { contains: query, mode: "insensitive" } }] }),
  };

  const { companies, counts, total } = await withPlatform(async (db) => {
    const companies = await db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        subscriptions: { include: { plan: true }, orderBy: { createdAt: "desc" }, take: 1 },
        users: { where: { userRoles: { some: { role: { key: "COMPANY_ADMIN" } } } }, take: 1, orderBy: { createdAt: "asc" } },
      },
    });
    const counts = await db.employee.groupBy({ by: ["companyId"], _count: { _all: true } });
    return { companies, counts, total: await db.company.count() };
  });
  const employeeCount = new Map(counts.map((c) => [c.companyId, c._count._all]));

  return (
    <div>
      <PageHeader
        title="Clients"
        description={`${total} client compan${total === 1 ? "y" : "ies"} on the platform.`}
        actions={
          <LinkButton href="/platform/clients/new" icon="plus">
            Add client
          </LinkButton>
        }
      />

      <form method="get" className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1 sm:max-w-sm">
          <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
          <input name="q" defaultValue={query} placeholder="Search clients" aria-label="Search clients" className={`${inputClass} pl-10`} />
        </div>
        <select name="status" defaultValue={statusFilter ?? ""} aria-label="Filter by status" className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm shadow-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0] + s.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <button className={buttonClass("secondary")}>Filter</button>
        {(query || statusFilter) && (
          <Link href="/platform/clients" className="text-sm font-medium text-brand-700 hover:underline">
            Clear
          </Link>
        )}
      </form>

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Company</Th>
              <Th>Company admin</Th>
              <Th>Plan</Th>
              <Th align="right">Employees</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c) => {
              const admin = c.users[0];
              return (
                <Tr key={c.id}>
                  <Td>
                    <Link href={`/platform/clients/${c.id}`} className="block font-medium text-ink hover:text-brand-700">
                      {c.name}
                    </Link>
                    <span className="text-xs text-ink-muted">{c.state}</span>
                  </Td>
                  <Td>
                    {admin ? (
                      <>
                        <span className="block text-ink-soft">{admin.email}</span>
                        {admin.status === "INVITED" && <span className="text-xs text-amber-700">Invitation pending</span>}
                      </>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td className="text-ink-soft">{c.subscriptions[0]?.plan.name ?? "—"}</Td>
                  <Td align="right" numeric>{employeeCount.get(c.id) ?? 0}</Td>
                  <Td>
                    <StatusBadge status={c.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-ink-soft">{fmtDate(c.createdAt)}</Td>
                </Tr>
              );
            })}
            {companies.length === 0 && (
              <EmptyRow colSpan={6}>
                {total === 0 ? (
                  <>
                    No clients yet.{" "}
                    <Link href="/platform/clients/new" className="font-medium text-brand-700 hover:underline">
                      Add your first client
                    </Link>
                  </>
                ) : (
                  "No clients match your filters."
                )}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
