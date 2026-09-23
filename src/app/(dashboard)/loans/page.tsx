import { redirect } from "next/navigation";
import { requireTenant } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { fmtDate, inr } from "@/lib/format";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyRow,
  Field,
  PageHeader,
  StatusBadge,
  SubmitButton,
  Table,
  TableCard,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
} from "@/components/ui";
import { applyLoanAction, decideLoanAction, withdrawLoanAction } from "./actions";

export default async function LoansPage() {
  const ctx = await requireTenant();
  const canApply = !!ctx.employeeId && can(ctx, "loan.request", "OWN");
  const canManage = can(ctx, "loan.manage", "COMPANY");
  if (!canApply && !canManage) redirect("/dashboard");

  const data = await withTenant(ctx.companyId, async (db) => {
    const pending = canManage
      ? await db.employeeLoan.findMany({ where: { status: "PENDING" }, include: { employee: true }, orderBy: { appliedDate: "asc" } })
      : [];
    const list = canManage
      ? await db.employeeLoan.findMany({ where: { status: { not: "PENDING" } }, include: { employee: true }, orderBy: { createdAt: "desc" }, take: 100 })
      : await db.employeeLoan.findMany({ where: { employeeId: ctx.employeeId! }, include: { employee: true }, orderBy: { createdAt: "desc" } });
    // HR/admin picks who they're applying for from the whole roster; an employee only ever applies for themselves.
    const employees = canManage
      ? await db.employee.findMany({ where: { status: { in: ["ACTIVE", "ON_LEAVE", "SUSPENDED"] } }, orderBy: { firstName: "asc" }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
      : [];
    return { pending, list, employees };
  });

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Loans & advances"
        description={canManage ? "Review requests, and see who's still repaying." : "Apply for a loan or salary advance, and track repayment."}
      />

      {(canApply || canManage) && (
        <Card className="mb-6">
          <CardHeader title="Apply" description="The monthly installment is the amount ÷ tenure. Which employees actually get deducted each month is chosen when payroll is processed." />
          <form action={applyLoanAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {canManage ? (
              <Field label="Employee" className="sm:col-span-2">
                <select name="employeeId" required defaultValue={ctx.employeeId ?? ""} className={inputClass}>
                  <option value="">Choose…</option>
                  {data.employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.firstName} {e.lastName}{e.id === ctx.employeeId ? " (you)" : ""}</option>
                  ))}
                </select>
              </Field>
            ) : (
              <input type="hidden" name="employeeId" value={ctx.employeeId!} />
            )}
            <Field label="Type">
              <select name="type" defaultValue="LOAN" className={inputClass}>
                <option value="LOAN">Loan</option>
                <option value="ADVANCE">Advance</option>
              </select>
            </Field>
            <Field label="Amount (₹)">
              <input name="principalAmount" type="number" min={1} step="0.01" required className={inputClass} />
            </Field>
            <Field label="Tenure (months)">
              <input name="tenureMonths" type="number" min={1} step="1" required defaultValue={1} className={inputClass} />
            </Field>
            <Field label="Reason (optional)">
              <input name="reason" className={inputClass} />
            </Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <SubmitButton icon="check">Submit request</SubmitButton>
            </div>
          </form>
        </Card>
      )}

      {canManage && data.pending.length > 0 && (
        <section className="mb-8" aria-labelledby="loan-inbox">
          <h2 id="loan-inbox" className="mb-3 flex items-center gap-2 text-base font-semibold text-ink">
            Waiting for a decision <Badge tone="amber">{data.pending.length}</Badge>
          </h2>
          <div className="space-y-3">
            {data.pending.map((loan) => (
              <Card key={loan.id} className="!p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Avatar name={`${loan.employee.firstName} ${loan.employee.lastName}`} size="sm" />
                    <div>
                      <p className="font-medium text-ink">
                        {loan.employee.firstName} {loan.employee.lastName}{" "}
                        <span className="font-normal text-ink-soft">
                          — {loan.type === "LOAN" ? "Loan" : "Advance"}, {inr(loan.principalAmount)} over {loan.tenureMonths} month{loan.tenureMonths === 1 ? "" : "s"}
                          {" "}({inr(loan.monthlyInstallment)}/mo)
                        </span>
                      </p>
                      <p className="text-sm text-ink-soft">Applied {fmtDate(loan.appliedDate)}</p>
                      {loan.reason && <p className="mt-1 text-sm text-ink-muted">“{loan.reason}”</p>}
                    </div>
                  </div>
                  <form action={decideLoanAction.bind(null, loan.id)} className="flex flex-wrap items-center gap-2">
                    <input name="comment" placeholder="Comment (optional)" aria-label="Comment" className={`${inputClass} w-52`} />
                    <button name="decision" value="APPROVE" className={buttonClass("primary", "sm")}>Approve</button>
                    <button name="decision" value="REJECT" className={buttonClass("secondary", "sm")}>Reject</button>
                  </form>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <h2 className="mb-3 text-base font-semibold text-ink">{canManage ? "All requests" : "Your requests"}</h2>
      <TableCard>
        <Table>
          <thead>
            <tr>
              {canManage && <Th>Employee</Th>}
              <Th>Type</Th>
              <Th align="right">Amount</Th>
              <Th align="right">Outstanding</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {[...(canManage ? [] : data.pending), ...data.list].map((loan) => {
              const canWithdraw = loan.status === "PENDING" && (canManage || loan.employeeId === ctx.employeeId);
              return (
                <Tr key={loan.id}>
                  {canManage && (
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={`${loan.employee.firstName} ${loan.employee.lastName}`} size="sm" />
                        <span className="font-medium">{loan.employee.firstName} {loan.employee.lastName}</span>
                      </span>
                    </Td>
                  )}
                  <Td>
                    <span className="block">{loan.type === "LOAN" ? "Loan" : "Advance"}</span>
                    <span className="block text-xs text-ink-muted">{loan.tenureMonths} mo · {inr(loan.monthlyInstallment)}/mo</span>
                  </Td>
                  <Td align="right" numeric>{inr(loan.principalAmount)}</Td>
                  <Td align="right" numeric>{loan.status === "APPROVED" || loan.status === "CLOSED" ? inr(loan.outstandingBalance) : "—"}</Td>
                  <Td>
                    <StatusBadge status={loan.status} />
                  </Td>
                  <Td align="right">
                    {canWithdraw && (
                      <form action={withdrawLoanAction.bind(null, loan.id)}>
                        <button className="text-xs font-medium text-rose-700 hover:underline">Withdraw</button>
                      </form>
                    )}
                  </Td>
                </Tr>
              );
            })}
            {data.pending.length === 0 && data.list.length === 0 && <EmptyRow colSpan={canManage ? 6 : 5}>No loan or advance requests yet.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
