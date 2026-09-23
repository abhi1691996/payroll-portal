import { notFound } from "next/navigation";
import { requirePermission } from "@/server/rbac/guard";
import { employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { inr } from "@/lib/format";
import type { PayrollBreakdown } from "@/lib/payroll-calculations";
import { Avatar, Card, LinkButton, PageHeader, cx } from "@/components/ui";

function Line({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div
      className={cx(
        "flex items-center justify-between py-2 text-sm",
        strong ? "border-t border-line font-semibold text-ink" : "text-ink-soft"
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-ink">{inr(value, 2)}</span>
    </div>
  );
}

export default async function PayslipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePermission("payslip.read", "OWN");

  // Inside the company AND inside the caller's scope: employees can only ever open their own.
  const payslip = await withTenant(ctx.companyId, (db) =>
    db.payslip.findFirst({
      where: { id, employee: employeeScopeWhere(ctx, "payslip.read") },
      include: { employee: true, payrollRun: true },
    })
  );

  if (!payslip) notFound();

  const breakdown = payslip.breakdown as unknown as PayrollBreakdown;
  const fullName = `${payslip.employee.firstName} ${payslip.employee.lastName}`;

  return (
    <div className="max-w-2xl">
      <PageHeader
        back={{ href: "/payslips", label: "Payslips" }}
        title={monthLabel(payslip.payrollRun.year, payslip.payrollRun.month)}
        actions={
          <LinkButton href={`/payslips/${payslip.id}/pdf`} icon="download" download>
            Download PDF
          </LinkButton>
        }
      />

      <Card className="space-y-6">
        <div className="flex items-center gap-3">
          <Avatar name={fullName} size="lg" />
          <div>
            <p className="text-lg font-semibold text-ink">{fullName}</p>
            <p className="text-sm text-ink-soft">
              <span className="font-mono">{payslip.employee.employeeCode}</span>
              {payslip.employee.designation ? ` · ${payslip.employee.designation}` : ""}
            </p>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Earnings</h2>
            {breakdown.earningLines ? (
              breakdown.earningLines.filter((l) => l.amount !== 0 || l.code === "BASIC").map((l) => (
                <Line key={l.code} label={l.name} value={l.amount} />
              ))
            ) : (
              <>
                <Line label="Basic" value={breakdown.earnings.basic} />
                <Line label="HRA" value={breakdown.earnings.hra} />
                <Line label="Special allowance" value={breakdown.earnings.specialAllowance} />
                {breakdown.earnings.otherAllowances > 0 && <Line label="Other allowances" value={breakdown.earnings.otherAllowances} />}
              </>
            )}
            <Line label="Gross pay" value={breakdown.grossPay} strong />
          </div>
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Deductions</h2>
            <Line label="Provident Fund" value={breakdown.employeeDeductions.providentFund} />
            <Line label="ESI" value={breakdown.employeeDeductions.esi} />
            <Line label="Professional Tax" value={breakdown.employeeDeductions.professionalTax} />
            <Line label="TDS" value={breakdown.employeeDeductions.tds} />
            <Line label="Total deductions" value={breakdown.totalDeductions} strong />
            {breakdown.otherDeductionLines && breakdown.otherDeductionLines.length > 0 && (
              <>
                {breakdown.otherDeductionLines.map((l) => (
                  <Line key={l.code} label={l.name} value={l.amount} />
                ))}
                <Line
                  label="Total deducted"
                  value={breakdown.totalDeductions + breakdown.otherDeductionLines.reduce((s, l) => s + l.amount, 0)}
                  strong
                />
              </>
            )}
          </div>
        </div>

        {breakdown.attendanceSummary && (breakdown.lopDays > 0 || breakdown.attendanceSummary.overtimeMinutes > 0) && (
          <div className="rounded-xl bg-canvas p-4 text-sm text-ink-soft">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Attendance for the month</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {breakdown.lopDays > 0 && (
                <li>
                  Loss of pay: <b className="font-medium text-ink">{breakdown.lopDays} day{breakdown.lopDays === 1 ? "" : "s"}</b>
                  {" "}({[
                    breakdown.attendanceSummary.absentDays > 0 && `${breakdown.attendanceSummary.absentDays} absent`,
                    breakdown.attendanceSummary.halfDays > 0 && `${breakdown.attendanceSummary.halfDays} from half days`,
                    breakdown.attendanceSummary.unpaidLeaveDays > 0 && `${breakdown.attendanceSummary.unpaidLeaveDays} unpaid leave`,
                    breakdown.attendanceSummary.lateHalfDays > 0 && `${breakdown.attendanceSummary.lateHalfDays} from ${breakdown.attendanceSummary.lateMarks} late marks`,
                    (breakdown.attendanceSummary.suspendedDays ?? 0) > 0 && `${breakdown.attendanceSummary.suspendedDays} suspended`,
                    (breakdown.attendanceSummary.separatedDays ?? 0) > 0 && `${breakdown.attendanceSummary.separatedDays} after leaving the company`,
                  ].filter(Boolean).join(", ")})
                </li>
              )}
              {breakdown.attendanceSummary.overtimeMinutes > 0 && <li>Overtime worked: {(breakdown.attendanceSummary.overtimeMinutes / 60).toFixed(1)} h</li>}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between rounded-2xl bg-gradient-to-r from-brand-600 to-brand-800 px-6 py-5 text-white">
          <div>
            <p className="text-sm text-brand-100">Net pay</p>
            {breakdown.lopDays > 0 && (
              <p className="text-xs text-brand-200/80">After {breakdown.lopDays} loss-of-pay day(s)</p>
            )}
          </div>
          <p className="text-3xl font-semibold tabular-nums">{inr(breakdown.netPay, 2)}</p>
        </div>
      </Card>
    </div>
  );
}
