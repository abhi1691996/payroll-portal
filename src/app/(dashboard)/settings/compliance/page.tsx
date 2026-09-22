import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { fmtDate, inr } from "@/lib/format";
import { DEFAULT_INCOME_TAX_SLABS, DEFAULT_PROFESSIONAL_TAX_SLABS, DEFAULT_STATUTORY } from "@/server/compliance/defaults";
import {
  Alert,
  Card,
  CardHeader,
  EmptyRow,
  Field,
  SubmitButton,
  Table,
  TableCard,
  TextInput,
  Td,
  Th,
  Tr,
  inputClass,
} from "@/components/ui";
import { addStatutoryConfig } from "../actions";

const PT_JSON = JSON.stringify(DEFAULT_PROFESSIONAL_TAX_SLABS, null, 2);
const TAX_JSON = JSON.stringify(DEFAULT_INCOME_TAX_SLABS, null, 2);
const pct = (v: unknown) => `${(Number(v) * 100).toFixed(2)}%`;

export default async function ComplianceRulesPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");
  const configs = await withTenant(ctx.companyId, (db) => db.statutoryConfig.findMany({ orderBy: { effectiveFrom: "desc" } }));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-soft">
          PF, ESI, Professional Tax and income-tax slabs. Each version applies from its effective date until a newer one
          replaces it. New companies start with these current India defaults.
        </p>
        <div className="mt-3">
          <Alert tone="warning">Verify these figures with your CA — they change periodically and vary by state.</Alert>
        </div>
      </div>

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Effective from</Th>
              <Th>PF (emp / empr)</Th>
              <Th align="right">PF ceiling</Th>
              <Th>ESI (emp / empr)</Th>
              <Th align="right">ESI threshold</Th>
            </tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <Tr key={c.id}>
                <Td className="whitespace-nowrap font-medium">{fmtDate(c.effectiveFrom)}</Td>
                <Td numeric>{pct(c.pfEmployeeRate)} / {pct(c.pfEmployerRate)}</Td>
                <Td align="right" numeric>{inr(c.pfWageCeiling)}</Td>
                <Td numeric>{pct(c.esiEmployeeRate)} / {pct(c.esiEmployerRate)}</Td>
                <Td align="right" numeric>{inr(c.esiWageThreshold)}</Td>
              </Tr>
            ))}
            {configs.length === 0 && <EmptyRow colSpan={5}>No statutory rates yet — add one below before running payroll.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>

      {canEdit && (
        <Card>
          <CardHeader title="Add a new version" description="Prefilled with the current rates — change what differs." />
          <form action={addStatutoryConfig} className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Effective from" name="effectiveFrom" type="date" required className="sm:col-span-2" />
            <TextInput label="PF employee rate" name="pfEmployeeRate" type="number" step="0.0001" defaultValue={DEFAULT_STATUTORY.pfEmployeeRate} required hint="e.g. 0.12 = 12%" />
            <TextInput label="PF employer rate" name="pfEmployerRate" type="number" step="0.0001" defaultValue={DEFAULT_STATUTORY.pfEmployerRate} required />
            <TextInput label="PF wage ceiling" name="pfWageCeiling" type="number" defaultValue={DEFAULT_STATUTORY.pfWageCeiling} required />
            <div className="hidden sm:block" />
            <TextInput label="ESI employee rate" name="esiEmployeeRate" type="number" step="0.0001" defaultValue={DEFAULT_STATUTORY.esiEmployeeRate} required hint="e.g. 0.0075 = 0.75%" />
            <TextInput label="ESI employer rate" name="esiEmployerRate" type="number" step="0.0001" defaultValue={DEFAULT_STATUTORY.esiEmployerRate} required />
            <TextInput label="ESI wage threshold" name="esiWageThreshold" type="number" defaultValue={DEFAULT_STATUTORY.esiWageThreshold} required />
            <div className="hidden sm:block" />
            <Field label="Professional Tax slabs (JSON)" className="sm:col-span-2">
              <textarea name="professionalTaxSlabs" defaultValue={PT_JSON} rows={5} className={`${inputClass} font-mono text-xs`} />
            </Field>
            <Field label="Income tax slabs by regime (JSON)" className="sm:col-span-2">
              <textarea name="incomeTaxSlabs" defaultValue={TAX_JSON} rows={10} className={`${inputClass} font-mono text-xs`} />
            </Field>
            <div className="sm:col-span-2">
              <SubmitButton icon="check">Add statutory config version</SubmitButton>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
