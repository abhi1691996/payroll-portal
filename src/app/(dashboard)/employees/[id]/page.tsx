import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireTenant } from "@/server/rbac/guard";
import { can, employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { loadRules } from "@/server/rules/load";
import { ensureLifecycleStatuses, SEPARATED_STATUSES } from "@/server/employees/lifecycle";
import { loadTemplates, readLines, toTemplateLines } from "@/server/salary/service";
import { formatMinutes } from "@/lib/time";
import { fmtDate, inr } from "@/lib/format";
import { SalaryAssignForm } from "@/components/salary-assign-form";
import { decisionRoute } from "@/server/approvals/service";
import {
  Alert,
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
import { assignEmployeeSalary, updateTaxRegime, updateWorkSettings } from "../actions";
import {
  decideResignationAction,
  endSuspensionAction,
  submitResignationAction,
  suspendEmployeeAction,
  terminateEmployeeAction,
  updateResignationNoticeAction,
  withdrawResignationAction,
} from "../offboarding-actions";

const today = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
};
const toInputDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value || "—"}</dd>
    </div>
  );
}

export default async function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireTenant();
  const { id } = await params;
  // Viewing your own profile only needs OWN scope (that's how a plain employee reaches their own
  // suspension/resignation status and applies for resignation); anyone else needs at least TEAM scope.
  if (!can(ctx, "employee.read", id === ctx.employeeId ? "OWN" : "TEAM")) redirect("/dashboard");
  const canSeeSalary = can(ctx, "employee.salary.read", "COMPANY");
  const canEditSalary = can(ctx, "employee.salary.write", "COMPANY");
  const canEditWork = can(ctx, "employee.update", "COMPANY");
  const canEditRegime = canEditWork || canEditSalary;
  const canOffboard = can(ctx, "employee.offboard", "COMPANY");

  const data = await withTenant(ctx.companyId, async (db) => {
    await ensureLifecycleStatuses(db);
    const employee = await db.employee.findFirst({
      where: { id, ...employeeScopeWhere(ctx, "employee.read") },
      include: { user: true },
    });
    if (!employee) return null;

    const salaries = canSeeSalary
      ? await db.employeeSalary.findMany({ where: { employeeId: employee.id }, orderBy: { effectiveFrom: "desc" }, include: { template: { select: { name: true } } } })
      : [];
    const templates = canEditSalary ? await loadTemplates(db) : [];
    const { shifts, setting } = await loadRules(db, ctx.companyId);
    const policies = await db.leavePolicy.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    const others = canEditWork
      ? await db.employee.findMany({ where: { id: { not: employee.id }, status: { notIn: SEPARATED_STATUSES } }, orderBy: { firstName: "asc" }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
      : [];
    const manager = employee.managerId
      ? await db.employee.findUnique({ where: { id: employee.managerId }, select: { firstName: true, lastName: true } })
      : null;

    // Offboarding: the one active suspension (if any) and the one active resignation/termination (if any),
    // plus whatever's needed to show it and, for a pending resignation, to decide it right here.
    const openSuspension = await db.employeeSuspension.findFirst({
      where: { employeeId: employee.id, fromDate: { lte: today() }, OR: [{ toDate: null }, { toDate: { gte: today() } }] },
      orderBy: { fromDate: "desc" },
    });
    const pastSuspensions = await db.employeeSuspension.findMany({
      where: { employeeId: employee.id, id: { not: openSuspension?.id } },
      orderBy: { fromDate: "desc" },
    });
    const activeSeparation = await db.employeeSeparation.findFirst({
      where: { employeeId: employee.id, status: { in: ["PENDING", "APPROVED"] } },
      orderBy: { createdAt: "desc" },
    });
    const pastSeparations = await db.employeeSeparation.findMany({
      where: { employeeId: employee.id, id: { not: activeSeparation?.id } },
      orderBy: { createdAt: "desc" },
    });
    let resignationApproval: { id: string; route: "level" | "override" | null } | null = null;
    if (activeSeparation?.type === "RESIGNATION" && activeSeparation.status === "PENDING") {
      const approval = await db.approvalRequest.findUnique({
        where: { entityType_entityId: { entityType: "RESIGNATION", entityId: activeSeparation.id } },
      });
      if (approval) resignationApproval = { id: approval.id, route: decisionRoute(ctx, approval, employee.managerId) };
    }

    return { employee, salaries, templates, shifts, setting, policies, others, manager, openSuspension, pastSuspensions, activeSeparation, pastSeparations, resignationApproval };
  });
  if (!data) notFound();
  const {
    employee, salaries, templates, shifts, setting, policies, others, manager,
    openSuspension, pastSuspensions, activeSeparation, pastSeparations, resignationApproval,
  } = data;

  const isSelf = ctx.employeeId === employee.id;
  const canApplyResignation = isSelf && can(ctx, "resignation.request", "OWN");
  const canWithdrawResignation = isSelf || canOffboard;
  const isSeparated = employee.status === "RESIGNED" || employee.status === "TERMINATED";

  const fullName = `${employee.firstName} ${employee.lastName}`;
  const shift = shifts.find((s) => s.id === (employee.shiftId ?? setting.defaultShiftId));
  const policy = policies.find((p) => p.id === (employee.leavePolicyId ?? setting.defaultLeavePolicyId));
  const current = salaries[0];

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        back={{ href: "/employees", label: "Employees" }}
        title={
          <span className="flex items-center gap-4">
            <Avatar name={fullName} size="lg" />
            <span className="min-w-0">
              <span className="block truncate">{fullName}</span>
              <span className="mt-1 flex items-center gap-2 text-sm font-normal text-ink-soft">
                <span className="font-mono">{employee.employeeCode}</span>
                <StatusBadge status={employee.status} />
              </span>
            </span>
          </span>
        }
      />

      <Card>
        <CardHeader title="Profile" />
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Login email" value={employee.user?.email} />
          <Detail label="Personal email" value={employee.personalEmail} />
          <Detail label="Phone" value={employee.phone} />
          <Detail label="Department" value={employee.department} />
          <Detail label="Designation" value={employee.designation} />
          <Detail label="State" value={employee.state} />
          <Detail label="Joined" value={fmtDate(employee.dateOfJoining)} />
          <Detail label="Income-tax regime" value={employee.taxRegime === "OLD" ? "Old regime" : "New regime"} />
          <Detail label="Reporting manager" value={manager ? `${manager.firstName} ${manager.lastName}` : null} />
          <Detail label="Shift" value={shift ? `${shift.name} (${shift.isFlexible ? "flexible" : `${formatMinutes(shift.startMinutes)} – ${formatMinutes(shift.endMinutes)}`})` : null} />
          <Detail label="Leave policy" value={policy?.name} />
          <Detail label="PAN" value={employee.panNumber} />
          <Detail label="Aadhaar" value={employee.aadhaarLast4 ? `•••• •••• ${employee.aadhaarLast4}` : null} />
          <Detail label="Bank account" value={employee.bankAccountNumber ? `••••${employee.bankAccountNumber.slice(-4)}` : null} />
          <Detail label="IFSC" value={employee.bankIfsc} />
        </dl>
      </Card>

      {canEditWork && (
        <Card>
          <CardHeader
            title="Work settings"
            description="Which shift and leave policy apply, and who approves this person's requests. Leave a choice blank to use the company default."
          />
          <form key={`${employee.shiftId}${employee.leavePolicyId}${employee.managerId}`} action={updateWorkSettings.bind(null, employee.id)} className="grid gap-4 sm:grid-cols-3">
            <Field label="Shift">
              <select name="shiftId" defaultValue={employee.shiftId ?? ""} className={inputClass}>
                <option value="">Company default</option>
                {shifts.filter((s) => s.active).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Leave policy">
              <select name="leavePolicyId" defaultValue={employee.leavePolicyId ?? ""} className={inputClass}>
                <option value="">Company default</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Reporting manager" hint="Their leave goes to this person first.">
              <select name="managerId" defaultValue={employee.managerId ?? ""} className={inputClass}>
                <option value="">None</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>{o.firstName} {o.lastName} ({o.employeeCode})</option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-3">
              <SubmitButton icon="check">Save work settings</SubmitButton>
            </div>
          </form>
        </Card>
      )}

      {(canOffboard || canApplyResignation || activeSeparation || openSuspension || isSeparated || resignationApproval) && (
        <Card>
          <CardHeader
            title="Offboarding"
            description="Suspension, resignation and termination. Past attendance, leave and payslips are never affected."
          />
          <div className="space-y-5">
            {isSeparated && activeSeparation && (
              <Alert tone={activeSeparation.type === "TERMINATION" ? "error" : "info"}>
                {activeSeparation.type === "TERMINATION" ? "Terminated" : "Resigned"}, effective {fmtDate(activeSeparation.lastWorkingDay)}.
                {activeSeparation.reason && <> Reason: {activeSeparation.reason}.</>} Kept for your records — see the{" "}
                <Link href="/employees/separated" className="font-medium underline">Separated</Link> list.
              </Alert>
            )}

            {!isSeparated && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-ink">Suspension</h3>
                {openSuspension ? (
                  <div className="rounded-xl bg-canvas p-4">
                    <p className="text-sm text-ink-soft">
                      Suspended since <b className="font-medium text-ink">{fmtDate(openSuspension.fromDate)}</b>
                      {openSuspension.toDate && <> until <b className="font-medium text-ink">{fmtDate(openSuspension.toDate)}</b></>}.
                      {openSuspension.reason && <> {openSuspension.reason}.</>} No pay accrues for these days.
                    </p>
                    {canOffboard && (
                      <form action={endSuspensionAction.bind(null, employee.id, openSuspension.id)} className="mt-3 flex flex-wrap items-end gap-3">
                        <Field label="Last suspended day" hint="They're active again from the next day onwards.">
                          <input name="toDate" type="date" defaultValue={toInputDate(addDays(today(), -1))} className={inputClass} />
                        </Field>
                        <SubmitButton icon="check" variant="secondary">End suspension</SubmitButton>
                      </form>
                    )}
                  </div>
                ) : canOffboard && !activeSeparation ? (
                  <form action={suspendEmployeeAction.bind(null, employee.id)} className="grid gap-3 sm:grid-cols-3">
                    <Field label="From">
                      <input name="fromDate" type="date" required defaultValue={toInputDate(today())} className={inputClass} />
                    </Field>
                    <Field label="Until (optional)" hint="Leave blank to end it manually later.">
                      <input name="toDate" type="date" className={inputClass} />
                    </Field>
                    <Field label="Reason" className="sm:col-span-1">
                      <input name="reason" className={inputClass} />
                    </Field>
                    <div className="sm:col-span-3">
                      <SubmitButton icon="warning" variant="secondary">Suspend</SubmitButton>
                    </div>
                  </form>
                ) : (
                  <p className="text-sm text-ink-muted">Not currently suspended.</p>
                )}
              </div>
            )}

            {!isSeparated && (
              <div className="border-t border-line pt-5">
                <h3 className="mb-2 text-sm font-semibold text-ink">Resignation</h3>
                {activeSeparation?.type === "RESIGNATION" ? (
                  <div className="space-y-3 rounded-xl bg-canvas p-4">
                    <p className="text-sm text-ink-soft">
                      Submitted <b className="font-medium text-ink">{fmtDate(activeSeparation.submittedDate)}</b>, notice period{" "}
                      <b className="font-medium text-ink">{activeSeparation.noticePeriodDays ?? 0} day{activeSeparation.noticePeriodDays === 1 ? "" : "s"}</b>,
                      last working day <b className="font-medium text-ink">{fmtDate(activeSeparation.lastWorkingDay)}</b>.{" "}
                      <StatusBadge status={activeSeparation.status} />
                      {activeSeparation.reason && <> — {activeSeparation.reason}</>}
                    </p>

                    {resignationApproval?.route && (
                      <form action={decideResignationAction.bind(null, employee.id, resignationApproval.id)} className="flex flex-wrap items-center gap-2">
                        <input name="comment" placeholder="Comment (optional)" className={`${inputClass} w-56`} />
                        <button name="decision" value="APPROVE" className={buttonClass("primary", "sm")}>
                          Approve
                        </button>
                        <button name="decision" value="REJECT" className={buttonClass("secondary", "sm")}>
                          Reject
                        </button>
                      </form>
                    )}

                    {canOffboard && (activeSeparation.status === "PENDING" || activeSeparation.status === "APPROVED") && (
                      <form action={updateResignationNoticeAction.bind(null, employee.id, activeSeparation.id)} className="flex flex-wrap items-end gap-3">
                        <Field label="Notice period (days)" hint="Editable any time before the last working day.">
                          <input name="noticePeriodDays" type="number" min={0} defaultValue={activeSeparation.noticePeriodDays ?? 0} className={`${inputClass} w-40`} />
                        </Field>
                        <SubmitButton icon="check" variant="secondary">Update notice period</SubmitButton>
                      </form>
                    )}

                    {canWithdrawResignation && (
                      <form action={withdrawResignationAction.bind(null, employee.id, activeSeparation.id)}>
                        <SubmitButton icon="close" variant="secondary">Withdraw resignation</SubmitButton>
                      </form>
                    )}
                  </div>
                ) : activeSeparation?.type === "TERMINATION" ? (
                  <p className="text-sm text-ink-muted">Not applicable — a termination is already on file below.</p>
                ) : canApplyResignation || canOffboard ? (
                  <form action={submitResignationAction.bind(null, employee.id)} className="grid gap-3 sm:grid-cols-3">
                    <Field label="Date of resignation">
                      <input name="submittedDate" type="date" required defaultValue={toInputDate(today())} className={inputClass} />
                    </Field>
                    <Field label="Notice period (days)">
                      <input name="noticePeriodDays" type="number" min={0} required defaultValue={30} className={inputClass} />
                    </Field>
                    <Field label="Reason (optional)">
                      <input name="reason" className={inputClass} />
                    </Field>
                    <div className="sm:col-span-3">
                      <SubmitButton icon="check" variant="secondary">
                        {isSelf ? "Submit resignation" : "Record resignation"}
                      </SubmitButton>
                    </div>
                  </form>
                ) : (
                  <p className="text-sm text-ink-muted">No resignation on file.</p>
                )}
              </div>
            )}

            {!isSeparated && canOffboard && !activeSeparation && (
              <div className="border-t border-line pt-5">
                <h3 className="mb-2 text-sm font-semibold text-ink">Termination</h3>
                <form action={terminateEmployeeAction.bind(null, employee.id)} className="grid gap-3 sm:grid-cols-3">
                  <Field label="Effective date" hint="Today, backdated, or a future date.">
                    <input name="terminationDate" type="date" required defaultValue={toInputDate(today())} className={inputClass} />
                  </Field>
                  <Field label="Reason (optional)" className="sm:col-span-2">
                    <input name="reason" className={inputClass} />
                  </Field>
                  <div className="sm:col-span-3">
                    <SubmitButton icon="error" variant="danger">Terminate employment</SubmitButton>
                  </div>
                </form>
              </div>
            )}

            {(pastSuspensions.length > 0 || pastSeparations.length > 0) && (
              <div className="border-t border-line pt-5">
                <h3 className="mb-2 text-sm font-semibold text-ink">History</h3>
                <ul className="space-y-1.5 text-sm text-ink-soft">
                  {pastSuspensions.map((s) => (
                    <li key={s.id}>
                      Suspended {fmtDate(s.fromDate)}{s.toDate && <> – {fmtDate(s.toDate)}</>}{s.reason && <> — {s.reason}</>}
                    </li>
                  ))}
                  {pastSeparations.map((s) => (
                    <li key={s.id}>
                      {s.type === "TERMINATION" ? "Termination" : "Resignation"} submitted {fmtDate(s.submittedDate)}, last working day {fmtDate(s.lastWorkingDay)}{" "}
                      <StatusBadge status={s.status} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {canSeeSalary && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-ink">Salary history</h2>
          <TableCard>
            <Table>
              <thead>
                <tr>
                  <Th>Effective from</Th>
                  <Th>Effective to</Th>
                  <Th>Structure</Th>
                  <Th align="right">CTC / yr</Th>
                  <Th align="right">Gross / month</Th>
                  <Th>Components</Th>
                </tr>
              </thead>
              <tbody>
                {salaries.map((s) => (
                  <Tr key={s.id}>
                    <Td className="whitespace-nowrap">{fmtDate(s.effectiveFrom)}</Td>
                    <Td className="whitespace-nowrap">{s.effectiveTo ? fmtDate(s.effectiveTo) : <Badge tone="green">Current</Badge>}</Td>
                    <Td className="text-ink-soft">{s.template?.name ?? "—"}</Td>
                    <Td align="right" numeric className="font-medium">{inr(s.ctcAnnual)}</Td>
                    <Td align="right" numeric className="font-semibold">{inr(s.grossMonthly)}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1.5">
                        {readLines(s.lines).map((l) => (
                          <span key={l.code} className="rounded-md bg-canvas px-2 py-0.5 text-xs text-ink-soft">
                            {l.name} <b className="font-medium text-ink">{inr(l.monthlyAmount)}</b>
                          </span>
                        ))}
                      </div>
                    </Td>
                  </Tr>
                ))}
                {salaries.length === 0 && <EmptyRow colSpan={6}>No salary set yet.</EmptyRow>}
              </tbody>
            </Table>
          </TableCard>
        </section>
      )}

      {canEditRegime && (
        <Card>
          <CardHeader
            title="Income-tax regime"
            description="The regime this employee has opted for. Payroll uses it to work out TDS from the next run onwards; finalized payslips are not changed."
          />
          {/* Keyed on the saved value so the dropdown always re-renders showing what is actually stored. */}
          <form key={employee.taxRegime} action={updateTaxRegime.bind(null, employee.id)} className="flex flex-wrap items-end gap-4">
            <Field label="Regime">
              <select name="taxRegime" defaultValue={employee.taxRegime} className={`${inputClass} w-56`}>
                <option value="NEW">New regime</option>
                <option value="OLD">Old regime</option>
              </select>
            </Field>
            <SubmitButton icon="check">Save regime</SubmitButton>
          </form>
        </Card>
      )}

      {canEditSalary && (
        <Card>
          <CardHeader
            title="Set / revise salary"
            description="Pick one of your salary structures and a CTC. The previous salary is closed the day before; history is kept."
          />
          <SalaryAssignForm
            templates={templates.map((t) => ({ id: t.id, name: t.name, lines: toTemplateLines(t) }))}
            action={assignEmployeeSalary.bind(null, employee.id)}
            defaultTemplateId={current?.templateId ?? undefined}
            defaultCtc={current ? Number(current.ctcAnnual) : undefined}
            defaultPf={current?.employerPfOptIn ?? true}
          />
        </Card>
      )}
    </div>
  );
}
