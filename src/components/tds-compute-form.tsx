"use client";

import { useMemo, useState } from "react";
import { computeTdsComputation, type TaxSlab, type TdsDeductionLine } from "@/lib/payroll-calculations";
import { Alert, Field, buttonClass, cx, inputClass, inputCompact } from "@/components/ui";
import { Icon } from "@/components/icons";
import { saveAndApproveTdsAction, saveTdsDraftAction } from "@/app/(dashboard)/payroll/tds/actions";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * The compute screen for one employee/financial year/regime: projected gross income and the deduction
 * lines are editable, everything else recomputes live (client-side — the math is the same pure function
 * payroll itself uses, just fed the company's slabs as a prop) as you type. Nothing is saved until
 * "Save as draft" or "Compute & approve".
 */
export function TdsComputeForm({
  employeeId,
  financialYear,
  taxRegime,
  initialGrossIncome,
  initialDeductionLines,
  tdsAlreadyDeducted,
  remainingMonths,
  slabs,
  nextVersion,
}: {
  employeeId: string;
  financialYear: number;
  taxRegime: "OLD" | "NEW";
  initialGrossIncome: number;
  initialDeductionLines: TdsDeductionLine[];
  tdsAlreadyDeducted: number;
  remainingMonths: number;
  slabs: TaxSlab[];
  nextVersion: number;
}) {
  const [grossIncome, setGrossIncome] = useState(initialGrossIncome);
  const [lines, setLines] = useState<TdsDeductionLine[]>(initialDeductionLines);
  const [newLineName, setNewLineName] = useState("");
  const [reason, setReason] = useState("");

  const result = useMemo(
    () => computeTdsComputation({ grossIncome, deductionLines: lines, tdsAlreadyDeducted, remainingMonths, slabs, taxRegime }),
    [grossIncome, lines, tdsAlreadyDeducted, remainingMonths, slabs, taxRegime]
  );

  const update = (i: number, patch: Partial<TdsDeductionLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => {
    if (!newLineName.trim()) return;
    setLines((ls) => [...ls, { code: newLineName.trim().toUpperCase().replace(/\s+/g, "_").slice(0, 20), name: newLineName.trim(), amount: 0 }]);
    setNewLineName("");
  };

  return (
    <form className="space-y-5">
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="financialYear" value={financialYear} />
      <input type="hidden" name="taxRegime" value={taxRegime} />
      <input type="hidden" name="grossIncome" value={grossIncome} />
      <input type="hidden" name="deductionLines" value={JSON.stringify(lines)} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Projected annual gross income (₹)" hint="Actual pay already processed this FY, plus the rest of the year at the current salary. Adjust if needed.">
          <input type="number" min={0} step="0.01" value={grossIncome} onChange={(e) => setGrossIncome(Number(e.target.value))} className={inputClass} />
        </Field>
        <Field label="TDS already deducted this FY" hint="From processed payslips — not editable here.">
          <input value={inr(tdsAlreadyDeducted)} disabled className={cx(inputClass, "bg-canvas text-ink-muted")} />
        </Field>
        <Field label="Months remaining" hint="FY months not yet paid; the balance is spread over these.">
          <input value={remainingMonths} disabled className={cx(inputClass, "bg-canvas text-ink-muted")} />
        </Field>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">Deductions &amp; exemptions</h3>
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-canvas/60 text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2.5 font-semibold">Line</th>
                <th className="px-3 py-2.5 font-semibold">Amount (₹ / year)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-line/70">
                  <td className="px-3 py-2 font-medium text-ink">{l.name}</td>
                  <td className="px-3 py-2">
                    <input type="number" min={0} step="0.01" value={l.amount} onChange={(e) => update(i, { amount: Number(e.target.value) })} className={cx(inputCompact, "w-40")} aria-label={`${l.name} amount`} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="text-xs font-medium text-rose-700 hover:underline" aria-label={`Remove ${l.name}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {lines.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-ink-muted">No deductions yet.</td></tr>}
              <tr className="border-t border-line bg-canvas/40 font-semibold">
                <td className="px-3 py-2.5">Total deductions</td>
                <td className="px-3 py-2.5" colSpan={2}>{inr(result.totalDeductions)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Add a deduction (e.g. 80C, 80D, HRA exemption)">
            <input value={newLineName} onChange={(e) => setNewLineName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLine(); } }} className={cx(inputClass, "w-64")} placeholder="Name" />
          </Field>
          <button type="button" onClick={addLine} className={buttonClass("secondary")}>
            <Icon name="plus" className="size-4" /> Add
          </button>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl bg-canvas p-4 text-sm sm:grid-cols-3">
        <div><dt className="text-ink-muted">Taxable income</dt><dd className="font-semibold text-ink">{inr(result.taxableIncome)}</dd></div>
        <div><dt className="text-ink-muted">Tax liability</dt><dd className="font-semibold text-ink">{inr(result.taxLiability)}</dd></div>
        <div><dt className="text-ink-muted">Rebate u/s 87A</dt><dd className="font-semibold text-ink">{result.rebate87A > 0 ? `- ${inr(result.rebate87A)}` : inr(0)}</dd></div>
        <div><dt className="text-ink-muted">Cess (4%)</dt><dd className="font-semibold text-ink">{inr(result.cess)}</dd></div>
        <div><dt className="text-ink-muted">Annual TDS liability</dt><dd className="font-semibold text-ink">{inr(result.annualTdsLiability)}</dd></div>
        <div><dt className="text-ink-muted">Balance TDS</dt><dd className="font-semibold text-ink">{inr(result.balanceTds)}</dd></div>
        <div><dt className="text-ink-muted">Monthly TDS (next {remainingMonths} month{remainingMonths === 1 ? "" : "s"})</dt><dd className="text-lg font-semibold text-brand-700">{inr(result.monthlyTds)}</dd></div>
      </div>

      {result.rebate87A > 0 && result.taxLiability - result.rebate87A <= 0 && (
        <Alert tone="info">Taxable income qualifies for the full Section 87A rebate — tax liability is nil.</Alert>
      )}
      {result.balanceTds < 0 && (
        <Alert tone="info">TDS already withheld this year exceeds the recalculated annual liability by {inr(-result.balanceTds)}. Nothing further is deducted through payroll — the surplus is reconciled at filing.</Alert>
      )}
      {remainingMonths === 0 && result.balanceTds > 0 && (
        <Alert tone="warning">Every FY month already has a payslip, so there is no month left to spread the balance over.</Alert>
      )}

      {nextVersion > 1 && (
        <Field label="Reason for this revision" hint="Required from V2 onward — shown in the version history.">
          <input name="revisionReason" value={reason} onChange={(e) => setReason(e.target.value)} required className={inputClass} placeholder="e.g. Salary revised in October" />
        </Field>
      )}
      {nextVersion === 1 && <input type="hidden" name="revisionReason" value={reason} />}

      <div className="flex flex-wrap gap-3">
        <button type="submit" formAction={saveTdsDraftAction} className={buttonClass("secondary")}>
          <Icon name="check" className="size-4" /> Save as draft (V{nextVersion})
        </button>
        <button type="submit" formAction={saveAndApproveTdsAction} className={buttonClass("primary")}>
          <Icon name="check" className="size-4" /> Compute &amp; approve (V{nextVersion})
        </button>
      </div>
    </form>
  );
}
