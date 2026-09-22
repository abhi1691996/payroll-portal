import Link from "next/link";
import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { ensureLifecycleStatuses, SEPARATED_STATUSES } from "@/server/employees/lifecycle";
import { fmtDate } from "@/lib/format";
import {
  Avatar,
  Badge,
  EmptyRow,
  PageHeader,
  StatusBadge,
  Table,
  TableCard,
  Tabs,
  Td,
  Th,
  Tr,
} from "@/components/ui";

/**
 * Everyone who has left the company: resigned (notice period run out) or terminated. They no longer
 * appear in the directory or in any operational picker, but nothing about them was deleted — their
 * attendance, leave and payslip history is exactly as it was.
 */
export default async function SeparatedEmployeesPage() {
  const ctx = await requirePermission("employee.read", "COMPANY");
  const canSeeSalary = can(ctx, "employee.salary.read", "COMPANY");

  const employees = await withTenant(ctx.companyId, async (db) => {
    await ensureLifecycleStatuses(db);
    return db.employee.findMany({
      where: { status: { in: SEPARATED_STATUSES } },
      orderBy: { dateOfExit: "desc" },
      include: {
        separations: { where: { status: "APPROVED" }, orderBy: { lastWorkingDay: "desc" }, take: 1 },
      },
    });
  });

  return (
    <div>
      <PageHeader
        title="Employees"
        description="People who have left. Kept for your records — attendance, leave and payslip history is untouched."
      />

      <Tabs
        items={[
          { href: "/employees", label: "Directory", active: false },
          ...(canSeeSalary ? [{ href: "/employees/salary", label: "Salaries", active: false }] : []),
          { href: "/employees/separated", label: "Separated", active: true, count: employees.length },
        ]}
      />

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Employee</Th>
              <Th>Code</Th>
              <Th>Department</Th>
              <Th>Type</Th>
              <Th>Submitted</Th>
              <Th>Last working day</Th>
              <Th>Reason</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => {
              const separation = emp.separations[0];
              return (
                <Tr key={emp.id}>
                  <Td>
                    <Link href={`/employees/${emp.id}`} className="flex items-center gap-3">
                      <Avatar name={`${emp.firstName} ${emp.lastName}`} />
                      <span className="block font-medium text-ink hover:text-brand-700">
                        {emp.firstName} {emp.lastName}
                      </span>
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs text-ink-soft">{emp.employeeCode}</Td>
                  <Td className="text-ink-soft">{emp.department ?? "—"}</Td>
                  <Td>
                    <Badge tone={separation?.type === "TERMINATION" ? "red" : "amber"}>
                      {separation?.type === "TERMINATION" ? "Terminated" : "Resigned"}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-ink-soft">{separation ? fmtDate(separation.submittedDate) : "—"}</Td>
                  <Td className="whitespace-nowrap">{emp.dateOfExit ? fmtDate(emp.dateOfExit) : "—"}</Td>
                  <Td className="max-w-xs truncate text-ink-soft">{separation?.reason ?? "—"}</Td>
                  <Td>
                    <StatusBadge status={emp.status} />
                  </Td>
                </Tr>
              );
            })}
            {employees.length === 0 && <EmptyRow colSpan={8}>Nobody has left yet.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
