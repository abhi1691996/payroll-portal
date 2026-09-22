import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { Alert, Card, CardHeader, Field, SubmitButton, inputClass } from "@/components/ui";
import { saveLeaveWorkflow } from "../rules-actions";

export default async function ApprovalRulesPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");

  const { levels, roles } = await withTenant(ctx.companyId, async (db) => {
    const workflow = await db.approvalWorkflow.findFirst({ where: { entityType: "LEAVE" }, include: { levels: { orderBy: { levelNo: "asc" } } } });
    return { levels: workflow?.levels ?? [], roles: await db.role.findMany({ where: { key: { not: "EMPLOYEE" } }, orderBy: { name: "asc" } }) };
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Leave approval"
          description="Who approves a leave request, in order. Each step must approve before it moves to the next."
        />
        <form key={JSON.stringify(levels.map((l) => [l.levelNo, l.approverType, l.roleKey]))} action={saveLeaveWorkflow} className="space-y-4">
          <fieldset disabled={!canEdit} className="contents">
            {[1, 2, 3, 4].map((n) => {
              const level = levels[n - 1];
              return (
                <div key={n} className="flex flex-wrap items-end gap-4 rounded-xl border border-line p-4">
                  <span className="w-16 pb-2.5 text-sm font-semibold text-ink">Step {n}</span>
                  <Field label="Approver">
                    <select name={`level_${n}_type`} defaultValue={level?.approverType ?? ""} className={`${inputClass} w-56`}>
                      <option value="">{n === 1 ? "No approval steps" : "— none —"}</option>
                      <option value="REPORTING_MANAGER">Reporting manager</option>
                      <option value="ROLE">A role (e.g. HR)</option>
                    </select>
                  </Field>
                  <Field label="Role (if a role)">
                    <select name={`level_${n}_role`} defaultValue={level?.roleKey ?? "HR_MANAGER"} className={`${inputClass} w-56`}>
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>{r.name}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              );
            })}
          </fieldset>
          {canEdit && <SubmitButton icon="check">Save approval steps</SubmitButton>}
        </form>
      </Card>

      <Alert tone="info">
        <ul className="list-disc space-y-1 pl-4">
          <li>An employee with <b>no reporting manager</b> skips any &quot;reporting manager&quot; step (set managers on each employee&apos;s profile).</li>
          <li>Users who can approve leave company-wide (HR, Company Admin) can always decide a request, whatever step it is on.</li>
          <li>Nobody can approve their own request.</li>
          <li>Changing these steps affects new requests only; requests already waiting keep the steps they started with.</li>
          <li>Every approval, rejection and comment is recorded in the audit log.</li>
        </ul>
      </Alert>
    </div>
  );
}
