import Link from "next/link";
import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { fmtDateTime, inr } from "@/lib/format";
import { eligibleLoansFor } from "@/server/loans/service";
import { attendanceIssuesFor, getPeriodLocks } from "@/server/payroll/locks";
import { adHocDeductionsFor } from "@/server/deductions/service";
import { ROSTER_STATUSES } from "@/server/employees/lifecycle";
import {
  Alert,
  buttonClass,
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
import {
  addAdHocDeductionAction,
  lockAttendanceAction,
  lockLoansAction,
  lockOtherDeductionsAction,
  processPayrollRun,
  removeAdHocDeductionAction,
  unlockAttendanceAction,
  unlockLoansAction,
  unlockOtherDeductionsAction,
} from "./actions";

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString("en-IN", { month: "long" })
);

export default async function PayrollRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const ctx = await requirePermission("payroll.read", "COMPANY");
  const canRun = can(ctx, "payroll.run", "COMPANY");
  const now = new Date();
  const sp = await searchParams;
  const month = Number(sp.month) || now.getMonth() + 1;
  const year = Number(sp.year) || now.getFullYear();

  const { runs, missingSalary, locks, attendanceIssues, eligibleLoans, adHocDeductions, employees, existingRun } = await withTenant(
    ctx.companyId,
    async (db) => {
      const locks = canRun ? await getPeriodLocks(db, month, year) : { attendance: null, loans: null, otherDeductions: null };
      return {
        runs: await db.payrollRun.findMany({
          orderBy: [{ year: "desc" }, { month: "desc" }],
          include: { _count: { select: { payslips: true } } },
        }),
        missingSalary: await db.employee.count({ where: { status: "ACTIVE", salaries: { none: {} } } }),
        existingRun: await db.payrollRun.findUnique({ where: { companyId_month_year: { companyId: ctx.companyId, month, year } } }),
        locks,
        attendanceIssues: canRun ? await attendanceIssuesFor(db, ctx.companyId, month, year) : [],
        eligibleLoans: canRun && locks.attendance ? await eligibleLoansFor(db, ctx.companyId, month, year) : [],
        adHocDeductions: canRun && locks.loans ? await adHocDeductionsFor(db, month, year) : [],
        employees: canRun && locks.loans
          ? await db.employee.findMany({ where: { status: { in: ROSTER_STATUSES } }, orderBy: { firstName: "asc" }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
          : [],
      };
    }
  );

  const periodLocked = existingRun?.status === "FINALIZED";
  const lockAttendanceWithPeriod = lockAttendanceAction.bind(null, month, year);
  const unlockAttendanceWithPeriod = unlockAttendanceAction.bind(null, month, year);
  const lockLoansWithPeriod = lockLoansAction.bind(null, month, year);
  const unlockLoansWithPeriod = unlockLoansAction.bind(null, month, year);
  const lockOtherWithPeriod = lockOtherDeductionsAction.bind(null, month, year);
  const unlockOtherWithPeriod = unlockOtherDeductionsAction.bind(null, month, year);
  const addAdHocWithPeriod = addAdHocDeductionAction.bind(null, month, year);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Payroll runs"
        description="Compute payslips for a period from salary structures and attendance."
      />

      {canRun && (
      <Card className="mb-8">
        <CardHeader title="Prepare payroll" description="Re-running a period recomputes and replaces its payslips until it is marked as paid." />

        <form method="get" className="mb-5 flex flex-wrap items-end gap-4 border-b border-line pb-5">
          <Field label="Month">
            <select name="month" defaultValue={month} className={cx(inputAuto, "w-44")}>
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <TextInput label="Year" name="year" type="number" defaultValue={year} className="w-28" />
          <button className={buttonClass("secondary")}>Go</button>
        </form>

        {periodLocked ? (
          <Alert tone="info">{monthLabel(year, month)} is marked as paid — nothing about this period can change anymore.</Alert>
        ) : (
          <div className="space-y-5">
            {/* Step 1: Attendance */}
            <div className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">1. Finalise &amp; lock attendance</h3>
                {locks.attendance ? (
                  <span className="flex items-center gap-3 text-xs text-ink-soft">
                    Locked {fmtDateTime(locks.attendance.lockedAt)}
                    <form action={unlockAttendanceWithPeriod}>
                      <button className="font-medium text-rose-700 hover:underline">Unlock</button>
                    </form>
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-700">Not locked</span>
                )}
              </div>

              {attendanceIssues.length > 0 && (
                <div className="mt-3">
                  <Alert tone="warning">
                    <p className="mb-1.5"><b className="font-medium">{attendanceIssues.length} employee{attendanceIssues.length === 1 ? "" : "s"}</b> have missing or flagged attendance for {monthLabel(year, month)}:</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {attendanceIssues.slice(0, 8).map((i) => (
                        <li key={i.employeeId}>
                          <span className="font-medium">{i.employeeName}</span> ({i.employeeCode})
                          {i.missingDates.length > 0 && ` — ${i.missingDates.length} day${i.missingDates.length === 1 ? "" : "s"} with no record`}
                          {i.flaggedDates.length > 0 && ` — ${i.flaggedDates.length} flagged`}
                        </li>
                      ))}
                      {attendanceIssues.length > 8 && <li>and {attendanceIssues.length - 8} more…</li>}
                    </ul>
                    <p className="mt-2"><Link href={`/attendance?month=${month}&year=${year}`} className="font-medium underline">Review attendance</Link></p>
                  </Alert>
                </div>
              )}

              {!locks.attendance && (
                <form action={lockAttendanceWithPeriod} className="mt-3">
                  {attendanceIssues.length > 0 && (
                    <label className="mb-3 flex items-start gap-2 text-sm text-ink-soft">
                      <input type="checkbox" name="acknowledgeIssues" required className="mt-0.5 size-4 rounded border-line accent-brand-600" />
                      I&apos;ve reviewed the issues above and want to lock attendance anyway
                    </label>
                  )}
                  <SubmitButton icon="shield" variant="secondary">Lock attendance for {monthLabel(year, month)}</SubmitButton>
                </form>
              )}
            </div>

            {/* Step 2: Loans */}
            <div className={cx("rounded-xl border border-line p-4", !locks.attendance && "opacity-50")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">2. Lock loan &amp; advance deductions</h3>
                {locks.loans ? (
                  <span className="flex items-center gap-3 text-xs text-ink-soft">
                    Locked {fmtDateTime(locks.loans.lockedAt)}
                    <form action={unlockLoansWithPeriod}>
                      <button className="font-medium text-rose-700 hover:underline">Unlock</button>
                    </form>
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-700">{locks.attendance ? "Not locked" : "Lock attendance first"}</span>
                )}
              </div>

              {locks.attendance && !locks.loans && (
                <form action={lockLoansWithPeriod} className="mt-3 space-y-3">
                  {eligibleLoans.length > 0 ? (
                    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                      {eligibleLoans.map((l) => (
                        <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                          <label className="flex items-center gap-3">
                            <input type="checkbox" name={`loan_${l.id}`} defaultChecked className="size-4 rounded border-line accent-brand-600" />
                            <span>
                              <span className="font-medium text-ink">{l.employeeName}</span>{" "}
                              <span className="text-ink-muted">({l.employeeCode}) — {l.type === "LOAN" ? "Loan" : "Advance"}</span>
                            </span>
                          </label>
                          <span className="text-ink-soft">
                            {inr(l.plannedAmount)} <span className="text-xs text-ink-muted">of {inr(l.outstandingBalance)} outstanding</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-ink-soft">No outstanding loans or advances to deduct this period.</p>
                  )}
                  <SubmitButton icon="shield" variant="secondary">Lock loan deductions for {monthLabel(year, month)}</SubmitButton>
                </form>
              )}
            </div>

            {/* Step 3: Other deductions */}
            <div className={cx("rounded-xl border border-line p-4", !locks.loans && "opacity-50")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">3. Lock any other deductions</h3>
                {locks.otherDeductions ? (
                  <span className="flex items-center gap-3 text-xs text-ink-soft">
                    Locked {fmtDateTime(locks.otherDeductions.lockedAt)}
                    <form action={unlockOtherWithPeriod}>
                      <button className="font-medium text-rose-700 hover:underline">Unlock</button>
                    </form>
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-700">{locks.loans ? "Not locked" : "Lock loan deductions first"}</span>
                )}
              </div>

              {locks.loans && (
                <div className="mt-3 space-y-3">
                  {adHocDeductions.length > 0 && (
                    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                      {adHocDeductions.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                          <span>
                            <span className="font-medium text-ink">{d.employeeName}</span>{" "}
                            <span className="text-ink-muted">({d.employeeCode}) — {d.name}</span>
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="text-ink-soft">{inr(d.amount)}</span>
                            {!locks.otherDeductions && (
                              <form action={removeAdHocDeductionAction.bind(null, d.id)}>
                                <button className="text-xs font-medium text-rose-700 hover:underline">Remove</button>
                              </form>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {!locks.otherDeductions && (
                    <>
                      <form action={addAdHocWithPeriod} className="flex flex-wrap items-end gap-3">
                        <Field label="Employee">
                          <select name="employeeId" className={cx(inputAuto, "w-56")} required>
                            {employees.map((e) => (
                              <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Description">
                          <input name="name" required className={cx(inputAuto, "w-48")} placeholder="e.g. Uniform cost" />
                        </Field>
                        <Field label="Amount (₹)">
                          <input name="amount" type="number" min={0.01} step="0.01" required className={cx(inputAuto, "w-32")} />
                        </Field>
                        <button className={buttonClass("secondary")}>
                          <Icon name="plus" className="size-4" /> Add
                        </button>
                      </form>
                      <form action={lockOtherWithPeriod}>
                        <SubmitButton icon="shield" variant="secondary">Lock other deductions for {monthLabel(year, month)}</SubmitButton>
                      </form>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Step 4: Run payroll */}
            <div className={cx("rounded-xl border border-line p-4", !(locks.attendance && locks.loans && locks.otherDeductions) && "opacity-50")}>
              <h3 className="mb-3 text-sm font-semibold text-ink">4. Run payroll</h3>
              {locks.attendance && locks.loans && locks.otherDeductions ? (
                <form action={processPayrollRun}>
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="year" value={year} />
                  <SubmitButton icon="payroll">
                    {existingRun ? "Regenerate" : "Process"} payroll for {monthLabel(year, month)}
                  </SubmitButton>
                </form>
              ) : (
                <p className="text-sm text-ink-soft">Complete steps 1-3 above first.</p>
              )}
            </div>
          </div>
        )}

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
