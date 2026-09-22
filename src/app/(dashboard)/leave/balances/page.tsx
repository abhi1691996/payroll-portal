import { requirePermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { leaveBalances } from "@/server/leave/service";
import { fmtDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyRow,
  Field,
  PageHeader,
  StatCard,
  SubmitButton,
  Table,
  TableCard,
  Tabs,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
} from "@/components/ui";
import { adjustBalanceAction } from "../actions";
import { SEPARATED_STATUSES } from "@/server/employees/lifecycle";

const KIND_TONE = { OPENING: "brand", ACCRUAL: "green", LEAVE_TAKEN: "amber", ADJUSTMENT: "violet", LAPSE: "red", REVERSAL: "sky" } as const;
const KIND_LABEL = { OPENING: "Opening", ACCRUAL: "Accrual", LEAVE_TAKEN: "Leave taken", ADJUSTMENT: "Adjustment", LAPSE: "Lapsed", REVERSAL: "Reversal" } as const;

export default async function LeaveBalancesPage({ searchParams }: { searchParams: Promise<{ employeeId?: string; typeId?: string }> }) {
  const ctx = await requirePermission("leave.manage", "COMPANY");
  const params = await searchParams;

  const data = await withTenant(ctx.companyId, async (db) => {
    const employees = await db.employee.findMany({ where: { status: { notIn: SEPARATED_STATUSES } }, orderBy: { employeeCode: "asc" }, select: { id: true, firstName: true, lastName: true, employeeCode: true } });
    const employeeId = params.employeeId ?? employees[0]?.id;
    if (!employeeId) return { employees, employeeId: null, balances: [], ledger: [], paidTypes: [] };
    const balances = await leaveBalances(db, ctx.companyId, employeeId);
    const ledger = await db.leaveLedger.findMany({
      where: { employeeId, ...(params.typeId ? { leaveTypeId: params.typeId } : {}) },
      include: { leaveType: true },
      orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
    });
    const paidTypes = await db.leaveType.findMany({ where: { isPaid: true, active: true }, orderBy: { name: "asc" } });
    return { employees, employeeId, balances, ledger, paidTypes };
  });

  // Running balance per leave type, so each row shows what the balance was right after it.
  const running = new Map<string, number>();
  const rows = data.ledger.map((e) => {
    const next = Math.round(((running.get(e.leaveTypeId) ?? 0) + Number(e.days)) * 100) / 100;
    running.set(e.leaveTypeId, next);
    return { ...e, after: next };
  });

  return (
    <div className="max-w-5xl">
      <PageHeader title="Leave balances" description="Every balance is the sum of ledger entries, so each change can be traced." />
      <Tabs
        items={[
          { href: "/leave", label: "Requests", active: false },
          { href: "/leave/balances", label: "Balances & ledger", active: true },
        ]}
      />

      <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <Field label="Employee">
          <select name="employeeId" defaultValue={data.employeeId ?? ""} className={`${inputClass} min-w-64`}>
            {data.employees.map((e) => (
              <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>
            ))}
          </select>
        </Field>
        <button className={buttonClass("secondary")}>Show</button>
      </form>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.balances.map((b) => (
          <StatCard key={b.leaveTypeId} label={b.name} value={b.balance} icon="leave" tone="violet" hint={`${b.pending ? b.pending + " pending · " : ""}${b.entitlementDays ?? 0} days / year`} />
        ))}
      </div>

      <h2 className="mb-3 text-base font-semibold text-ink">Ledger</h2>
      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Leave type</Th>
              <Th>Entry</Th>
              <Th align="right">Days</Th>
              <Th align="right">Balance after</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <Tr key={e.id}>
                <Td className="whitespace-nowrap text-ink-soft">{fmtDate(e.effectiveDate)}</Td>
                <Td>{e.leaveType.name}</Td>
                <Td><Badge tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind]}</Badge></Td>
                <Td align="right" numeric className={Number(e.days) < 0 ? "text-rose-600" : "text-emerald-700"}>
                  {Number(e.days) > 0 ? "+" : ""}{e.days.toString()}
                </Td>
                <Td align="right" numeric className="font-medium">{e.after}</Td>
                <Td className="text-ink-muted">{e.note ?? ""}</Td>
              </Tr>
            ))}
            {rows.length === 0 && <EmptyRow colSpan={6}>No entries yet.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>

      {data.employeeId && (
        <Card className="mt-6">
          <CardHeader title="Adjust balance" description="Adds one ledger entry with your reason — use a negative number to remove days." />
          <form action={adjustBalanceAction} className="grid gap-4 sm:grid-cols-4">
            <input type="hidden" name="employeeId" value={data.employeeId} />
            <Field label="Leave type">
              <select name="leaveTypeId" required className={inputClass}>
                {data.paidTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Days (+/−)">
              <input name="days" type="number" step="0.5" required className={inputClass} />
            </Field>
            <Field label="Reason" className="sm:col-span-2">
              <input name="note" required className={inputClass} placeholder="e.g. Comp-off for weekend work" />
            </Field>
            <div className="sm:col-span-4">
              <SubmitButton icon="check">Add adjustment</SubmitButton>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
