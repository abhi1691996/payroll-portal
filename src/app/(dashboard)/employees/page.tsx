import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/server/rbac/guard";
import { can, employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { fmtDate } from "@/lib/format";
import { BulkImport } from "@/components/bulk-import";
import { BulkPanel } from "@/components/bulk-panel";
import { Icon } from "@/components/icons";
import {
  Avatar,
  EmptyRow,
  LinkButton,
  PageHeader,
  StatusBadge,
  Table,
  TableCard,
  Tabs,
  Td,
  Th,
  Tr,
  inputClass,
  inputAuto,
  buttonClass,
} from "@/components/ui";
import { ensureLifecycleStatuses, ROSTER_STATUSES } from "@/server/employees/lifecycle";

// The directory shows who's currently on the team. Resigned / terminated people have their own
// "Separated" report — they never clutter this list, but nothing about them is deleted.
const STATUSES = ["ACTIVE", "ON_LEAVE", "SUSPENDED"] as const;

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; bulk?: string }>;
}) {
  const ctx = await requirePermission("employee.read", "TEAM");
  const { q, status, bulk } = await searchParams;
  const canImport = can(ctx, "employee.import", "COMPANY");
  const canCreate = can(ctx, "employee.create", "COMPANY");
  const canSeeSalary = can(ctx, "employee.salary.read", "COMPANY");
  const canSeeSeparated = can(ctx, "employee.read", "COMPANY");
  const query = q?.trim() ?? "";
  const statusFilter = STATUSES.find((s) => s === status);

  const where: Prisma.EmployeeWhereInput = {
    status: statusFilter ?? { in: ROSTER_STATUSES },
    ...(query && {
      OR: [
        { firstName: { contains: query } },
        { lastName: { contains: query } },
        { employeeCode: { contains: query } },
        { department: { contains: query } },
        { user: { email: { contains: query } } },
      ],
    }),
  };

  // Managers see only their team; HR/Admin see everyone (still only inside this company).
  const scope = employeeScopeWhere(ctx, "employee.read");
  const { employees, totalCount } = await withTenant(ctx.companyId, async (db) => {
    await ensureLifecycleStatuses(db);
    return {
      employees: await db.employee.findMany({
        where: { AND: [scope, where] },
        orderBy: { firstName: "asc" },
        include: { user: true },
      }),
      totalCount: await db.employee.count({ where: { AND: [scope, { status: { in: ROSTER_STATUSES } }] } }),
    };
  });

  return (
    <div>
      <PageHeader
        title="Employees"
        description="Everyone on payroll. Add people one at a time, or upload a whole sheet at once."
        actions={
          <>
            {canImport && (
              <LinkButton href="/bulk/employees/export.csv" variant="secondary" icon="download" download>
                Export
              </LinkButton>
            )}
            {canCreate && (
              <LinkButton href="/employees/new" icon="plus">
                Add employee
              </LinkButton>
            )}
          </>
        }
      />

      <Tabs
        items={[
          { href: "/employees", label: "Directory", active: true, count: totalCount },
          ...(canSeeSalary ? [{ href: "/employees/salary", label: "Salaries", active: false }] : []),
          ...(canSeeSeparated ? [{ href: "/employees/separated", label: "Separated", active: false }] : []),
        ]}
      />

      {canImport && (
      <BulkPanel
        title="Bulk upload employees"
        subtitle="Create many logins and profiles from one CSV — with a preview before anything is saved."
        defaultOpen={bulk === "1" || totalCount === 0}
      >
        <BulkImport
          kind="employees"
          unit="employee"
          title="Import employees from CSV"
          description="Each row creates a login and an employee profile. Leave tempPassword blank and we'll generate one per person."
          columnsHint="Required: employeeCode, firstName, lastName, email, dateOfJoining, state. Optional: department, designation, phone, PAN, bank details, tempPassword."
          templates={[{ label: "Download template", href: "/bulk/employees/template.csv" }]}
          exports={[{ label: "Export current list", href: "/bulk/employees/export.csv" }]}
        >
          <p className="text-sm text-ink-soft">
            Existing employee codes and login emails are skipped, never overwritten. Add salary structures
            afterwards from the{" "}
            <Link href="/employees/salary" className="font-medium text-brand-700 hover:underline">
              Salary structures
            </Link>{" "}
            tab.
          </p>
        </BulkImport>
      </BulkPanel>
      )}

      <form method="get" className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1 sm:max-w-sm">
          <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
          <input
            name="q"
            defaultValue={query}
            placeholder="Search name, code, department or email"
            className={`${inputClass} pl-10`}
            aria-label="Search employees"
          />
        </div>
        <select
          name="status"
          defaultValue={statusFilter ?? ""}
          className={inputAuto}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "ON_LEAVE" ? "On leave" : s[0] + s.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
        <button className={buttonClass("secondary")}>Filter</button>
        {(query || statusFilter) && (
          <Link href="/employees" className="text-sm font-medium text-brand-700 hover:underline">
            Clear
          </Link>
        )}
      </form>

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Employee</Th>
              <Th>Code</Th>
              <Th>Department</Th>
              <Th>Joined</Th>
              <Th>Tax regime</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <Tr key={emp.id}>
                <Td>
                  <Link href={`/employees/${emp.id}`} className="flex items-center gap-3">
                    <Avatar name={`${emp.firstName} ${emp.lastName}`} />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink hover:text-brand-700">
                        {emp.firstName} {emp.lastName}
                      </span>
                      <span className="block truncate text-xs text-ink-muted">{emp.user?.email ?? "No portal login"}</span>
                    </span>
                  </Link>
                </Td>
                <Td className="font-mono text-xs text-ink-soft">{emp.employeeCode}</Td>
                <Td>
                  <span className="block text-ink-soft">{emp.department ?? "—"}</span>
                  {emp.designation && <span className="block text-xs text-ink-muted">{emp.designation}</span>}
                </Td>
                <Td className="whitespace-nowrap text-ink-soft">{fmtDate(emp.dateOfJoining)}</Td>
                <Td>
                  <StatusBadge status={emp.taxRegime} />
                </Td>
                <Td>
                  <StatusBadge status={emp.status} />
                </Td>
              </Tr>
            ))}
            {employees.length === 0 && (
              <EmptyRow colSpan={6}>
                {totalCount === 0
                  ? "No employees yet — add one, or use bulk upload above."
                  : "No employees match your filters."}
              </EmptyRow>
            )}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
