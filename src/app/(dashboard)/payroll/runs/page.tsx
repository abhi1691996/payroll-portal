import Link from "next/link";
import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import {
  Alert,
  Card,
  CardHeader,
  cx,
  EmptyRow,
  Field,
  PageHeader,
  StatusBadge,
  SubmitButton,
  Table,
  TableCard,
  Td,
  TextInput,
  Th,
  Tr,
  inputAuto,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { processPayrollRun } from "./actions";

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString("en-IN", { month: "long" })
);

export default async function PayrollRunsPage() {
  const ctx = await requirePermission("payroll.read", "COMPANY");
  const canRun = can(ctx, "payroll.run", "COMPANY");
  const { runs, missingSalary } = await withTenant(ctx.companyId, async (db) => ({
    runs: await db.payrollRun.findMany({
      orderBy: [{ year: "desc" }, { month: "desc" }],
      include: { _count: { select: { payslips: true } } },
    }),
    missingSalary: await db.employee.count({ where: { status: "ACTIVE", salaries: { none: {} } } }),
  }));

  const now = new Date();

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Payroll runs"
        description="Compute payslips for a month from salary structures and attendance."
      />

      {canRun && (
      <Card className="mb-8">
        <CardHeader title="Run payroll" description="Re-running a month recomputes and replaces its payslips until it is finalized." />
        <form action={processPayrollRun} className="flex flex-wrap items-end gap-4">
          <Field label="Month">
            <select name="month" defaultValue={now.getMonth() + 1} className={cx(inputAuto, "w-44")}>
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <TextInput label="Year" name="year" type="number" defaultValue={now.getFullYear()} className="w-28" />
          <SubmitButton icon="payroll">Process payroll</SubmitButton>
        </form>

        {missingSalary > 0 && (
          <div className="mt-4">
            <Alert tone="warning">
              <p>
                <b className="font-medium">
                  {missingSalary} active employee{missingSalary === 1 ? " has" : "s have"} no salary structure
                </b>{" "}
                and will be skipped.{" "}
                <Link href="/employees/salary?bulk=1#bulk-upload" className="font-medium underline">
                  Upload salaries
                </Link>
              </p>
            </Alert>
          </div>
        )}
      </Card>
      )}

      <h2 className="mb-3 text-base font-semibold text-ink">History</h2>
      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Period</Th>
              <Th>Status</Th>
              <Th align="right">Payslips</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <Tr key={run.id}>
                <Td>
                  <Link href={`/payroll/runs/${run.id}`} className="font-medium text-ink hover:text-brand-700">
                    {monthLabel(run.year, run.month)}
                  </Link>
                </Td>
                <Td>
                  <StatusBadge status={run.status} />
                </Td>
                <Td align="right" numeric className="text-ink-soft">
                  {run._count.payslips}
                </Td>
                <Td align="right">
                  <Link href={`/payroll/runs/${run.id}`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
                    Open <Icon name="arrow-right" className="size-3.5" />
                  </Link>
                </Td>
              </Tr>
            ))}
            {runs.length === 0 && <EmptyRow colSpan={4}>No payroll runs yet.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
