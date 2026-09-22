import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { loadRules } from "@/server/rules/load";
import { Card, CardHeader, Field, SubmitButton, TextInput, inputClass } from "@/components/ui";
import { saveEmployeeSettings } from "../rules-actions";

export default async function EmployeeSettingsPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");
  const { setting, shifts, policies } = await withTenant(ctx.companyId, async (db) => ({
    ...(await loadRules(db, ctx.companyId)),
    policies: await db.leavePolicy.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
  }));

  return (
    <Card>
      <CardHeader title="Employee settings" description="Defaults applied when you add employees." />
      <form action={saveEmployeeSettings} className="grid gap-4 sm:grid-cols-2">
        <fieldset disabled={!canEdit} className="contents">
          <TextInput
            label="Employee code prefix"
            name="employeeCodePrefix"
            defaultValue={setting.employeeCodePrefix}
            hint="Used for numbering, e.g. EMP → EMP001, EMP002…"
          />
          <label className="flex items-center gap-3 self-end rounded-xl border border-line px-4 py-2.5 text-sm text-ink">
            <input name="autoGenerateEmployeeCode" type="checkbox" defaultChecked={setting.autoGenerateEmployeeCode} className="size-4 rounded border-line accent-brand-600" />
            Numbers are generated automatically when the code is left blank
          </label>
          <Field label="Default income-tax regime" hint="For new employees. Each employee's own choice is set on their profile.">
            <select name="defaultTaxRegime" defaultValue={setting.defaultTaxRegime} className={inputClass}>
              <option value="NEW">New regime</option>
              <option value="OLD">Old regime</option>
            </select>
          </Field>
          <Field label="Default shift" hint="Applies to anyone without a shift of their own.">
            <select name="defaultShiftId" defaultValue={setting.defaultShiftId ?? ""} className={inputClass}>
              {shifts.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Default leave policy" hint="Applies to anyone without a policy of their own.">
            <select name="defaultLeavePolicyId" defaultValue={setting.defaultLeavePolicyId ?? ""} className={inputClass}>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
        </fieldset>
        {canEdit && (
          <div className="sm:col-span-2">
            <SubmitButton icon="check">Save employee settings</SubmitButton>
          </div>
        )}
      </form>
    </Card>
  );
}
