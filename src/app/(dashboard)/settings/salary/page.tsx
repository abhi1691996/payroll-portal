import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { Alert, Badge, Card, CardHeader, Field, SubmitButton, TextInput, inputClass } from "@/components/ui";
import { saveSalaryComponent, saveSalaryTemplate } from "../rules-actions";
import { TemplateEditor, type EditorLine } from "./template-editor";

const CALC_LABEL = { FIXED: "Fixed ₹", PERCENT_OF_BASIC: "% of Basic", PERCENT_OF_CTC: "% of CTC", BALANCE: "Balancing figure" } as const;

function Flag({ name, defaultChecked, label }: { name: string; defaultChecked: boolean; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input name={name} type="checkbox" defaultChecked={defaultChecked} className="size-4 rounded border-line accent-brand-600" /> {label}
    </label>
  );
}

export default async function SalaryRulesPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");

  const { components, templates, usage } = await withTenant(ctx.companyId, async (db) => ({
    components: await db.salaryComponent.findMany({ orderBy: { sortOrder: "asc" } }),
    templates: await db.salaryTemplate.findMany({ orderBy: { name: "asc" }, include: { lines: { orderBy: { sortOrder: "asc" } } } }),
    usage: await db.employeeSalary.groupBy({ by: ["templateId"], where: { effectiveTo: null }, _count: { _all: true } }),
  }));
  const active = components.filter((c) => c.active);
  const usedBy = new Map(usage.map((u) => [u.templateId, u._count._all]));

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-soft">
        Every company pays differently, so nothing here is fixed. First define the <b className="font-medium text-ink">components</b> you pay
        (Basic, HRA, Conveyance, Car allowance…), then build one or more <b className="font-medium text-ink">structures</b> from them
        (&quot;Standard&quot;, &quot;Manager&quot;…). Employees are then assigned a structure and a CTC.
      </p>

      <Card>
        <CardHeader title="Pay components" description="What each one is, and which statutory calculations include it." />
        <ul className="divide-y divide-line/70">
          {components.map((c) => (
            <li key={c.id} className="py-3">
              <details>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3">
                  <span className="font-medium text-ink">{c.name}</span>
                  <span className="font-mono text-xs text-ink-muted">{c.code}</span>
                  {c.isBasic && <Badge tone="brand">Basic</Badge>}
                  {!c.active && <Badge>Not in use</Badge>}
                  <span className="text-xs text-ink-muted">
                    {CALC_LABEL[c.calcType]}{c.calcType !== "BALANCE" ? ` ${c.defaultValue.toString()}` : ""} ·{" "}
                    {[c.taxable && "taxable", c.includeInPf && "PF", c.includeInEsi && "ESI", c.includeInPt && "PT"].filter(Boolean).join(" · ") || "no statutory inclusion"}
                  </span>
                  <span className="ml-auto text-sm font-medium text-brand-700">Edit</span>
                </summary>
                <form action={saveSalaryComponent} className="mt-4 grid gap-4 rounded-xl bg-canvas/50 p-4 sm:grid-cols-3">
                  <input type="hidden" name="id" value={c.id} />
                  <fieldset disabled={!canEdit} className="contents">
                    <TextInput label="Name" name="name" defaultValue={c.name} required />
                    <Field label="Default calculation">
                      <select name="calcType" defaultValue={c.calcType} className={inputClass}>
                        {Object.entries(CALC_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </Field>
                    <TextInput label="Default value" name="defaultValue" type="number" step="0.01" defaultValue={c.defaultValue.toString()} hint="₹ or % depending on the calculation" />
                    <div className="grid gap-2 sm:col-span-3 sm:grid-cols-3">
                      <Flag name="isBasic" defaultChecked={c.isBasic} label="This is the Basic" />
                      <Flag name="taxable" defaultChecked={c.taxable} label="Taxable (counts for TDS)" />
                      <Flag name="includeInPf" defaultChecked={c.includeInPf} label="Counts as PF wages" />
                      <Flag name="includeInEsi" defaultChecked={c.includeInEsi} label="Counts as ESI wages" />
                      <Flag name="includeInPt" defaultChecked={c.includeInPt} label="Counts for Professional Tax" />
                      <Flag name="active" defaultChecked={c.active} label="In use" />
                    </div>
                  </fieldset>
                  {canEdit && <div className="sm:col-span-3"><SubmitButton icon="check">Save component</SubmitButton></div>}
                </form>
              </details>
            </li>
          ))}
        </ul>

        {canEdit && (
          <form action={saveSalaryComponent} className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-4">
            <TextInput label="New component" name="name" required placeholder="e.g. Conveyance" />
            <TextInput label="Short code" name="code" required placeholder="e.g. CONV" hint="Used in CSV uploads." />
            <Field label="Calculated as">
              <select name="calcType" defaultValue="FIXED" className={inputClass}>
                {Object.entries(CALC_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            <TextInput label="Default value" name="defaultValue" type="number" step="0.01" defaultValue="0" />
            <div className="flex flex-wrap gap-x-6 gap-y-2 sm:col-span-4">
              <Flag name="taxable" defaultChecked label="Taxable" />
              <Flag name="includeInPf" defaultChecked={false} label="Counts as PF wages" />
              <Flag name="includeInEsi" defaultChecked label="Counts as ESI wages" />
              <Flag name="includeInPt" defaultChecked label="Counts for Professional Tax" />
              <input type="hidden" name="active" value="on" />
            </div>
            <div className="sm:col-span-4"><SubmitButton icon="plus">Add component</SubmitButton></div>
          </form>
        )}
      </Card>

      <div>
        <h2 className="mb-3 text-base font-semibold text-ink">Salary structures</h2>
        {active.length === 0 && <Alert tone="warning">Add at least one pay component above before creating a structure.</Alert>}
        <div className="space-y-4">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardHeader
                title={<span className="flex items-center gap-2">{t.name}{!t.active && <Badge>Inactive</Badge>}</span>}
                description={`${usedBy.get(t.id) ?? 0} employee${(usedBy.get(t.id) ?? 0) === 1 ? "" : "s"} currently on this structure. Editing it doesn't change what anyone is already paid — it applies to salaries you set from now on.`}
              />
              <TemplateEditor
                key={JSON.stringify(t.lines.map((l) => [l.componentId, l.calcType, l.value.toString()]))}
                components={active.map((c) => ({ id: c.id, code: c.code, name: c.name, isBasic: c.isBasic, taxable: c.taxable, includeInPf: c.includeInPf, includeInEsi: c.includeInEsi, includeInPt: c.includeInPt, sortOrder: c.sortOrder }))}
                initial={{ id: t.id, name: t.name, description: t.description ?? "", active: t.active, lines: t.lines.map<EditorLine>((l) => ({ componentId: l.componentId, calcType: l.calcType, value: Number(l.value) })) }}
                action={saveSalaryTemplate}
                canEdit={canEdit}
                submitLabel="Save structure"
              />
            </Card>
          ))}
          {canEdit && active.length > 0 && (
            <Card>
              <CardHeader title="Create a salary structure" description="e.g. a “Manager” structure with a car allowance and bonus." />
              <TemplateEditor
                components={active.map((c) => ({ id: c.id, code: c.code, name: c.name, isBasic: c.isBasic, taxable: c.taxable, includeInPf: c.includeInPf, includeInEsi: c.includeInEsi, includeInPt: c.includeInPt, sortOrder: c.sortOrder }))}
                action={saveSalaryTemplate}
                canEdit
                submitLabel="Create structure"
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

