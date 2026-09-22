import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { inr } from "@/lib/format";
import {
  Avatar,
  EmptyRow,
  PageHeader,
  StatCard,
  StatusBadge,
  SubmitButton,
  Table,
  TableCard,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { finalizePayrollRun } from "../actions";

export default async function PayrollRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requirePermission("payroll.read", "COMPANY");
  const canFinalize = can(ctx, "payroll.finalize", "COMPANY");
  const { id } = await params;

  const run = await withTenant(ctx.companyId, (db) =>
    db.payrollRun.findUnique({
      where: { id },
      include: {
        payslips: {
          include: { employee: true },
          orderBy: { employee: { firstName: "asc" } },
        },
      },
    })
  );

  if (!run) notFound();

  const totals = run.payslips.reduce(
    (acc, p) => ({
      gross: acc.gross + Number(p.grossPay),
      deductions: acc.deductions + Number(p.totalDeductions),
      net: acc.net + Number(p.netPay),
    }),
    { gross: 0, deductions: 0, net: 0 }
  );

  const finalizeWithId = finalizePayrollRun.bind(null, run.id);

  return (
    <div className="max-w-5xl">
      <PageHeader
        back={{ href: "/payroll/runs", label: "Payroll runs" }}
        title={
          <span className="flex items-center gap-3">
            {monthLabel(run.year, run.month)}
            <StatusBadge status={run.status} />
          </span>
        }
        description={`${run.payslips.length} payslip${run.payslips.length === 1 ? "" : "s"} in this run.`}
        actions={
          run.status === "PROCESSED" && canFinalize && (
            <form action={finalizeWithId}>
              <SubmitButton icon="check">Finalize run</SubmitButton>
            </form>
          )
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Total gross" value={inr(totals.gross)} icon="payroll" tone="brand" />
        <StatCard label="Total deductions" value={inr(totals.deductions)} icon="warning" tone="amber" />
        <StatCard label="Total net pay" value={inr(totals.net)} icon="check" tone="green" />
      </div>

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Employee</Th>
              <Th align="right">Gross</Th>
              <Th align="right">Deductions</Th>
              <Th align="right">Net pay</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {run.payslips.map((p) => (
              <Tr key={p.id}>
                <Td>
                  <span className="flex items-center gap-3">
                    <Avatar name={`${p.employee.firstName} ${p.employee.lastName}`} size="sm" />
                    <span className="font-medium">
                      {p.employee.firstName} {p.employee.lastName}
                    </span>
                  </span>
                </Td>
                <Td align="right" numeric>{inr(p.grossPay)}</Td>
                <Td align="right" numeric className="text-ink-soft">{inr(p.totalDeductions)}</Td>
                <Td align="right" numeric className="font-semibold">{inr(p.netPay)}</Td>
                <Td align="right">
                  <Link href={`/payslips/${p.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                    View
                  </Link>
                </Td>
              </Tr>
            ))}
            {run.payslips.length === 0 && <EmptyRow colSpan={5}>No payslips in this run.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
