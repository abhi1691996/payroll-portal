import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { LEAVE_TYPE_CATALOGUE } from "@/server/companies/defaults";
import { MONTHS } from "@/lib/india";
import { Badge, Card, CardHeader, Field, SubmitButton, TextInput, buttonClass, inputClass, inputCompact, cx } from "@/components/ui";
import { createLeavePolicy, saveLeavePolicy, saveLeaveType, saveLeaveYear } from "../rules-actions";

const num = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? "" : v.toString());

export default async function LeaveRulesPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");

  const { types, policies, setting, employeeCounts } = await withTenant(ctx.companyId, async (db) => ({
    types: await db.leaveType.findMany({ orderBy: [{ isPaid: "desc" }, { name: "asc" }] }),
    policies: await db.leavePolicy.findMany({ orderBy: { createdAt: "asc" }, include: { rules: true } }),
    setting: await db.companySetting.findFirstOrThrow(),
    employeeCounts: await db.employee.groupBy({ by: ["leavePolicyId"], _count: { _all: true } }),
  }));
  const onPolicy = new Map(employeeCounts.map((c) => [c.leavePolicyId, c._count._all]));
  const paidTypes = types.filter((t) => t.isPaid && t.active);
  const missingFromCatalogue = LEAVE_TYPE_CATALOGUE.filter((c) => !types.some((t) => t.code === c.code));

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-soft">
        Leave has two layers. <b className="font-medium text-ink">Leave types</b> are the kinds of leave your company uses.
        <b className="font-medium text-ink"> Policies</b> say how much of each an employee gets, and how it accrues and carries forward.
      </p>

      <Card>
        <CardHeader title="Leave year" description="Balances accrue and carry forward within this year." />
        <form action={saveLeaveYear} className="flex flex-wrap items-end gap-4">
          <fieldset disabled={!canEdit} className="contents">
            <Field label="Leave year starts in">
              <select name="leaveYearStartMonth" defaultValue={setting.leaveYearStartMonth} className={`${inputClass} w-48`}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </Field>
          </fieldset>
          {canEdit && <SubmitButton icon="check">Save</SubmitButton>}
        </form>
      </Card>

      <Card>
        <CardHeader title="Leave types" description="Turn off the ones you don't use. Unpaid types (Loss of Pay) cost salary and have no balance." />
        <ul className="divide-y divide-line/70">
          {types.map((t) => (
            <li key={t.id} className="py-3">
              <form action={saveLeaveType} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={t.id} />
                <fieldset disabled={!canEdit} className="contents">
                  <input name="name" defaultValue={t.name} aria-label="Leave type name" className={cx(inputCompact, "w-56")} />
                  <span className="font-mono text-xs text-ink-muted">{t.code}</span>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input name="isPaid" type="checkbox" defaultChecked={t.isPaid} className="size-4 rounded border-line accent-brand-600" /> Paid
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input name="active" type="checkbox" defaultChecked={t.active} className="size-4 rounded border-line accent-brand-600" /> In use
                  </label>
                </fieldset>
                {canEdit && <button className={buttonClass("secondary", "sm")}>Save</button>}
                {!t.active && <Badge>Not in use</Badge>}
              </form>
            </li>
          ))}
        </ul>

        {canEdit && (
          <div className="mt-4 space-y-4 border-t border-line pt-4">
            {missingFromCatalogue.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium text-ink">Add a common type</p>
                <div className="flex flex-wrap gap-2">
                  {missingFromCatalogue.map((c) => (
                    <form key={c.code} action={saveLeaveType}>
                      <input type="hidden" name="name" value={c.name} />
                      <input type="hidden" name="code" value={c.code} />
                      {c.isPaid && <input type="hidden" name="isPaid" value="on" />}
                      <button className={buttonClass("secondary", "sm")}>+ {c.name}</button>
                    </form>
                  ))}
                </div>
              </div>
            )}
            <form action={saveLeaveType} className="flex flex-wrap items-end gap-3">
              <TextInput label="Or create your own" name="name" required placeholder="e.g. Study Leave" />
              <label className="flex items-center gap-2 pb-2.5 text-sm text-ink">
                <input name="isPaid" type="checkbox" defaultChecked className="size-4 rounded border-line accent-brand-600" /> Paid
              </label>
              <SubmitButton icon="plus">Add leave type</SubmitButton>
            </form>
          </div>
        )}
      </Card>

      {policies.map((p) => {
        const byType = new Map(p.rules.map((r) => [r.leaveTypeId, r]));
        return (
          <Card key={p.id}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {p.name}
                  {setting.defaultLeavePolicyId === p.id && <Badge tone="brand">Company default</Badge>}
                  {!p.active && <Badge>Inactive</Badge>}
                </span>
              }
              description={`${onPolicy.get(p.id) ?? 0} employees${setting.defaultLeavePolicyId === p.id ? ` (+ ${onPolicy.get(null) ?? 0} using the default)` : ""}`}
            />
            <form key={JSON.stringify(p.rules.map((r) => [r.id, r.entitlementDays.toString()]))} action={saveLeavePolicy.bind(null, p.id)} className="space-y-4">
              <fieldset disabled={!canEdit} className="contents">
                <div className="flex flex-wrap items-end gap-4">
                  <TextInput label="Policy name" name="name" defaultValue={p.name} required />
                  <label className="flex items-center gap-2 pb-2.5 text-sm text-ink">
                    <input name="active" type="checkbox" defaultChecked={p.active} className="size-4 rounded border-line accent-brand-600" /> Active
                  </label>
                </div>
                <div className="thin-scroll overflow-x-auto rounded-xl border border-line">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="bg-canvas/60 text-left text-xs uppercase tracking-wide text-ink-muted">
                        {["Included", "Leave type", "Days / year", "Accrual", "Carry forward", "Max carry", "Max balance", "Half day", "Max in a row", "Count weekly offs", "Count holidays"].map((h) => (
                          <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {paidTypes.map((t) => {
                        const r = byType.get(t.id);
                        const cb = (name: string, on: boolean | undefined) => (
                          <input name={`${name}_${t.id}`} type="checkbox" defaultChecked={on} className="size-4 rounded border-line accent-brand-600" />
                        );
                        return (
                          <tr key={t.id} className="border-t border-line/70">
                            <td className="px-3 py-2">{cb("use", !!r)}</td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">{t.name}</td>
                            <td className="px-3 py-2"><input name={`ent_${t.id}`} type="number" step="0.5" min={0} defaultValue={num(r?.entitlementDays) || "0"} className={cx(inputCompact, "w-20")} aria-label={`${t.name} days per year`} /></td>
                            <td className="px-3 py-2">
                              <select name={`acc_${t.id}`} defaultValue={r?.accrual ?? "UPFRONT"} className={cx(inputCompact, "w-36")} aria-label={`${t.name} accrual`}>
                                <option value="UPFRONT">All at year start</option>
                                <option value="MONTHLY">Monthly</option>
                              </select>
                            </td>
                            <td className="px-3 py-2">{cb("carry", r?.carryForward)}</td>
                            <td className="px-3 py-2"><input name={`maxcarry_${t.id}`} type="number" step="0.5" min={0} defaultValue={num(r?.maxCarryForwardDays)} placeholder="all" className={cx(inputCompact, "w-20")} aria-label={`${t.name} max carry forward`} /></td>
                            <td className="px-3 py-2"><input name={`maxbal_${t.id}`} type="number" step="0.5" min={0} defaultValue={num(r?.maxBalance)} placeholder="none" className={cx(inputCompact, "w-20")} aria-label={`${t.name} max balance`} /></td>
                            <td className="px-3 py-2">{cb("half", r ? r.allowHalfDay : true)}</td>
                            <td className="px-3 py-2"><input name={`maxconsec_${t.id}`} type="number" min={1} defaultValue={num(r?.maxConsecutiveDays)} placeholder="any" className={cx(inputCompact, "w-20")} aria-label={`${t.name} max consecutive days`} /></td>
                            <td className="px-3 py-2">{cb("wo", r?.countWeeklyOffs)}</td>
                            <td className="px-3 py-2">{cb("hol", r?.countHolidays)}</td>
                          </tr>
                        );
                      })}
                      {paidTypes.length === 0 && <tr><td colSpan={11} className="px-3 py-6 text-center text-ink-muted">Add a paid leave type first.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-ink-muted">
                  Example — Casual Leave: 12 days, accrues monthly (1 a month), no carry forward. Earned Leave: 18 days, monthly, carry forward, max balance 45.
                </p>
              </fieldset>
              {canEdit && <SubmitButton icon="check">Save policy</SubmitButton>}
            </form>
          </Card>
        );
      })}

      {canEdit && (
        <Card>
          <CardHeader title="Add a policy" description="e.g. one for permanent staff, another for interns or a different location." />
          <form action={createLeavePolicy} className="flex flex-wrap items-end gap-3">
            <TextInput label="Policy name" name="name" required placeholder="e.g. Permanent staff" />
            <SubmitButton icon="plus">Create policy</SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
