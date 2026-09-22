import Link from "next/link";
import { requirePermission } from "@/server/rbac/guard";
import { can, employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { inr } from "@/lib/format";
import { Avatar, EmptyRow, PageHeader, Table, TableCard, Td, Th, Tr } from "@/components/ui";

export default async function PayslipsPage() {
  const ctx = await requirePermission("payslip.read", "OWN");
  // Company-wide payslip access (payroll/finance) vs. only your own.
  const isAdmin = can(ctx, "payslip.read", "COMPANY");

  const payslips = await withTenant(ctx.companyId, (db) =>
    db.payslip.findMany({
      where: { employee: employeeScopeWhere(ctx, "payslip.read") },
      include: { payrollRun: true, employee: true },
      orderBy: [{ payrollRun: { year: "desc" } }, { payrollRun: { month: "desc" } }],
      take: 100,
    })
  );

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Payslips"
        description={isAdmin ? "Latest 100 payslips across all runs." : "Your monthly payslips."}
      />
      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Period</Th>
              {isAdmin && <Th>Employee</Th>}
              <Th align="right">Net pay</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {payslips.map((p) => (
              <Tr key={p.id}>
                <Td className="font-medium">{monthLabel(p.payrollRun.year, p.payrollRun.month)}</Td>
                {isAdmin && (
                  <Td>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={`${p.employee.firstName} ${p.employee.lastName}`} size="sm" />
                      {p.employee.firstName} {p.employee.lastName}
                    </span>
                  </Td>
                )}
                <Td align="right" numeric className="font-semibold">{inr(p.netPay)}</Td>
                <Td align="right">
                  <Link href={`/payslips/${p.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                    View
                  </Link>
                </Td>
              </Tr>
            ))}
            {payslips.length === 0 && <EmptyRow colSpan={isAdmin ? 4 : 3}>No payslips yet.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
