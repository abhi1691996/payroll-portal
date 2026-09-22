import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import {
  Card,
  CardHeader,
  Field,
  SubmitButton,
  TextInput,
  inputClass,
} from "@/components/ui";
import { saveCompany } from "./actions";

export default async function SettingsPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");

  const company = await withTenant(ctx.companyId, (db) => db.company.findFirst());

  return (
    <div className="space-y-10">
      <Card>
        <CardHeader title="Company details" />
        <form action={saveCompany} className="grid gap-4 sm:grid-cols-2">
          <fieldset disabled={!canEdit} className="contents">
            <TextInput label="Company name" name="name" defaultValue={company?.name} required />
            <TextInput label="State" name="state" defaultValue={company?.state} required />
            <Field label="Address" className="sm:col-span-2">
              <textarea name="address" defaultValue={company?.address} required rows={2} className={inputClass} />
            </Field>
            <TextInput label="PAN" name="pan" defaultValue={company?.pan ?? ""} />
            <TextInput label="TAN" name="tan" defaultValue={company?.tan ?? ""} />
            <TextInput label="PF establishment ID" name="pfEstablishmentId" defaultValue={company?.pfEstablishmentId ?? ""} />
            <TextInput label="ESI establishment ID" name="esiEstablishmentId" defaultValue={company?.esiEstablishmentId ?? ""} />
            <TextInput
              label="Pay cycle start day"
              name="payCycleStartDay"
              type="number"
              min={1}
              max={28}
              defaultValue={company?.payCycleStartDay ?? 1}
            />
          </fieldset>
          {canEdit && (
            <div className="sm:col-span-2">
              <SubmitButton icon="check">Save company details</SubmitButton>
            </div>
          )}
        </form>
      </Card>

    </div>
  );
}
