import { requirePermission } from "@/server/rbac/guard";
import { can, employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { actionableRequests, type LevelSnapshot } from "@/server/approvals/service";
import { leaveBalances } from "@/server/leave/service";
import { fmtDate } from "@/lib/format";
import { BulkImport } from "@/components/bulk-import";
import { BulkPanel } from "@/components/bulk-panel";
import {
  Avatar,
  Badge,
  Card,
  CardHeader,
  EmptyRow,
  LinkButton,
  PageHeader,
  StatCard,
  StatusBadge,
  Table,
  TableCard,
  Tabs,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
} from "@/components/ui";
import { cancelLeaveAction, decideLeaveAction } from "./actions";
import { LeaveApplyForm } from "./apply-form";

const dates = (a: Date, b: Date) => (a.getTime() === b.getTime() ? fmtDate(a) : `${fmtDate(a)} → ${fmtDate(b)}`);
const ROLE_LABEL: Record<string, string> = { HR_MANAGER: "HR", COMPANY_ADMIN: "Admin", PAYROLL_MANAGER: "Payroll", FINANCE_MANAGER: "Finance", MANAGER: "Manager" };

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ bulk?: string }> }) {
  const { bulk } = await searchParams;
  const ctx = await requirePermission("leave.read", "OWN");

  // What this user may do, derived from permissions rather than a role name:
  const seesOthers = can(ctx, "leave.read", "TEAM"); // admin/HR: everyone, manager: their team
  const canApprove = can(ctx, "leave.approve", "TEAM");
  const canManage = can(ctx, "leave.manage", "COMPANY");
  const canRequest = can(ctx, "leave.request", "OWN") && !!ctx.employeeId;
  const scope = employeeScopeWhere(ctx, "leave.read");

  const data = await withTenant(ctx.companyId, async (db) => {
    const requests = await db.leaveRequest.findMany({
      where: { employee: scope },
      include: { employee: true, leaveType: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const approvals = await db.approvalRequest.findMany({ where: { entityType: "LEAVE", entityId: { in: requests.map((r) => r.id) } } });
    const balances = canRequest ? await leaveBalances(db, ctx.companyId, ctx.employeeId!) : [];
    const unpaid = canRequest ? await db.leaveType.findMany({ where: { active: true, isPaid: false }, orderBy: { name: "asc" } }) : [];
    const inbox = canApprove ? await actionableRequests(db, ctx, "LEAVE") : [];
    const inboxLeaves = await db.leaveRequest.findMany({ where: { id: { in: inbox.map((i) => i.request.entityId) } }, include: { employee: true, leaveType: true } });
    const pendingAll = seesOthers ? await db.leaveRequest.count({ where: { status: "PENDING", employee: scope } }) : 0;
    return { requests, approvals, balances, unpaid, inbox, inboxLeaves, pendingAll };
  });
  const approvalOf = new Map(data.approvals.map((a) => [a.entityId, a]));
  const inboxLeaf = new Map(data.inboxLeaves.map((l) => [l.id, l]));

  /** "Waiting for: Reporting manager" from the workflow snapshot taken when the request was made. */
  const waitingFor = (leaveId: string) => {
    const a = approvalOf.get(leaveId);
    if (!a || a.status !== "PENDING") return null;
    const levels = a.levelsSnapshot as unknown as LevelSnapshot[];
    const current = levels.find((l) => l.levelNo === a.currentLevel);
    if (!current) return "HR / Admin";
    const step = `${current.levelNo} of ${levels.length}`;
    return `${current.approverType === "REPORTING_MANAGER" ? "Reporting manager" : (ROLE_LABEL[current.roleKey ?? ""] ?? current.roleKey)} (step ${step})`;
  };

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Leave"
        description={canApprove ? "Apply for leave, and review the requests waiting for you." : "Apply for leave and see your balances."}
      />

      {canManage && (
        <Tabs
          items={[
            { href: "/leave", label: "Requests", active: true },
            { href: "/leave/balances", label: "Balances & ledger", active: false },
          ]}
        />
      )}

      {canRequest && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {data.balances.map((b) => (
              <StatCard
                key={b.leaveTypeId}
                label={b.name}
                value={b.available}
                icon="leave"
                tone="violet"
                hint={`${b.balance} in ledger${b.pending ? ` · ${b.pending} pending` : ""}`}
              />
            ))}
            {data.balances.length === 0 && (
              <Card className="sm:col-span-2 lg:col-span-4">
                <p className="text-sm text-ink-muted">No leave balances yet — your leave policy has no paid leave types.</p>
              </Card>
            )}
          </div>

          <Card className="mb-6">
            <CardHeader title="Apply for leave" />
            <LeaveApplyForm
              types={[
                ...data.balances.map((b) => ({ id: b.leaveTypeId, name: b.name, isPaid: true, available: b.available })),
                ...data.unpaid.map((t) => ({ id: t.id, name: t.name, isPaid: false, available: null })),
              ]}
            />
          </Card>
        </>
      )}

      {data.inbox.length > 0 && (
        <section className="mb-8" aria-labelledby="inbox">
          <h2 id="inbox" className="mb-3 flex items-center gap-2 text-base font-semibold text-ink">
            Waiting for your approval <Badge tone="amber">{data.inbox.length}</Badge>
          </h2>
          <div className="space-y-3">
            {data.inbox.map(({ request, route }) => {
              const leave = inboxLeaf.get(request.entityId);
              if (!leave) return null;
              return (
                <Card key={request.id} className="!p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <Avatar name={`${leave.employee.firstName} ${leave.employee.lastName}`} size="sm" />
                      <div>
                        <p className="font-medium text-ink">
                          {leave.employee.firstName} {leave.employee.lastName}{" "}
                          <span className="font-normal text-ink-soft">— {leave.leaveType.name}, {leave.days.toString()} day{Number(leave.days) === 1 ? "" : "s"}{leave.isHalfDay ? " (half day)" : ""}</span>
                        </p>
                        <p className="text-sm text-ink-soft">{dates(leave.startDate, leave.endDate)}</p>
                        {leave.reason && <p className="mt-1 text-sm text-ink-muted">“{leave.reason}”</p>}
                        {route === "override" && <p className="mt-1 text-xs text-amber-700">You&apos;re deciding as HR / admin, not as the assigned approver.</p>}
                      </div>
                    </div>
                    <form action={decideLeaveAction.bind(null, leave.id)} className="flex flex-wrap items-center gap-2">
                      <input name="comment" placeholder="Comment (optional)" aria-label="Comment" className={`${inputClass} w-52`} />
                      <button name="decision" value="APPROVE" className={buttonClass("primary", "sm")}>Approve</button>
                      <button name="decision" value="REJECT" className={buttonClass("secondary", "sm")}>Reject</button>
                    </form>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      <h2 className="mb-3 text-base font-semibold text-ink">{seesOthers ? "Leave requests" : "Your requests"}</h2>
      <TableCard>
        <Table>
          <thead>
            <tr>
              {seesOthers && <Th>Employee</Th>}
              <Th>Type</Th>
              <Th>Dates</Th>
              <Th align="right">Days</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {data.requests.map((r) => {
              const waiting = waitingFor(r.id);
              const own = r.employeeId === ctx.employeeId;
              const canCancel = (r.status === "PENDING" && (own || canManage)) || (r.status === "APPROVED" && canManage);
              return (
                <Tr key={r.id}>
                  {seesOthers && (
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={`${r.employee.firstName} ${r.employee.lastName}`} size="sm" />
                        <span className="font-medium">{r.employee.firstName} {r.employee.lastName}</span>
                      </span>
                    </Td>
                  )}
                  <Td>
                    <span className="block">{r.leaveType.name}{r.isHalfDay ? " (half)" : ""}</span>
                    {r.reason && <span className="block max-w-56 truncate text-xs text-ink-muted">{r.reason}</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-soft">{dates(r.startDate, r.endDate)}</Td>
                  <Td align="right" numeric>{r.days.toString()}</Td>
                  <Td>
                    <StatusBadge status={r.status} />
                    {waiting && <span className="mt-1 block text-xs text-ink-muted">Waiting for {waiting}</span>}
                  </Td>
                  <Td align="right">
                    {canCancel && (
                      <form action={cancelLeaveAction.bind(null, r.id)}>
                        <button className="text-xs font-medium text-rose-700 hover:underline">{r.status === "APPROVED" ? "Revoke" : "Cancel"}</button>
                      </form>
                    )}
                  </Td>
                </Tr>
              );
            })}
            {data.requests.length === 0 && <EmptyRow colSpan={seesOthers ? 6 : 5}>No leave requests.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>

      {canManage && (
        <div className="mt-8">
          <BulkPanel
            title="Bulk upload leave"
            subtitle="Set opening leave balances, or import past leave records."
            defaultOpen={bulk === "1"}
          >
            <div className="space-y-4">
              <BulkImport
                kind="leave-balances"
                unit="balance"
                title="Leave balances"
                description="Sets each employee's balance for a leave type as of a date. The difference is added to the ledger — nothing is overwritten."
                columnsHint="Required: employeeCode, leaveType, balance (days, decimals allowed). Optional: asOf (date; default today)."
                templates={[{ label: "Download template", href: "/bulk/leave-balances/template.csv" }]}
                exports={[{ label: "Export balances", href: "/bulk/leave-balances/export.csv" }]}
              />
              <BulkImport
                kind="leave-requests"
                unit="record"
                title="Past leave records"
                description="Historical leave for the record. Days are counted with your working week and holidays. These don't change balances."
                columnsHint="Required: employeeCode, leaveType, startDate, endDate. Optional: status (PENDING / APPROVED / REJECTED / CANCELLED), reason."
                templates={[{ label: "Download template", href: "/bulk/leave-requests/template.csv" }]}
                exports={[{ label: "Export all", href: "/bulk/leave-requests/export.csv" }]}
              />
            </div>
          </BulkPanel>
          <div className="mt-4 flex gap-2">
            <LinkButton href="/settings/leave" variant="secondary" icon="settings">Leave rules</LinkButton>
          </div>
        </div>
      )}
    </div>
  );
}
