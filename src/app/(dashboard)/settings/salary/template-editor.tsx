"use client";

import { useMemo, useState } from "react";
import { computeSalaryLines, validateTemplateLines, type CalcType } from "@/lib/salary/compute";
import { Alert, Field, buttonClass, inputClass, inputCompact, cx } from "@/components/ui";
import { Icon } from "@/components/icons";

export interface ComponentOption {
  id: string;
  code: string;
  name: string;
  isBasic: boolean;
  taxable: boolean;
  includeInPf: boolean;
  includeInEsi: boolean;
  includeInPt: boolean;
  sortOrder: number;
}

export interface EditorLine {
  componentId: string;
  calcType: CalcType;
  value: number;
}

const CALC_LABEL: Record<CalcType, string> = {
  FIXED: "Fixed amount (₹ / month)",
  PERCENT_OF_BASIC: "% of Basic",
  PERCENT_OF_CTC: "% of monthly CTC",
  BALANCE: "Balancing figure (the rest of CTC)",
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Build a salary structure: pick components and say how each is worked out. The sample panel recalculates
 * as you edit so you can see exactly what an employee on this structure would get.
 */
export function TemplateEditor({
  components,
  initial,
  action,
  canEdit,
  submitLabel,
}: {
  components: ComponentOption[];
  initial?: { id?: string; name: string; description: string; active: boolean; lines: EditorLine[] };
  action: (formData: FormData) => void | Promise<void>;
  canEdit: boolean;
  submitLabel: string;
}) {
  const [lines, setLines] = useState<EditorLine[]>(initial?.lines ?? []);
  const [sampleCtc, setSampleCtc] = useState("600000");
  const byId = useMemo(() => new Map(components.map((c) => [c.id, c])), [components]);
  const unused = components.filter((c) => !lines.some((l) => l.componentId === c.id));

  const templateLines = useMemo(
    () =>
      lines
        .filter((l) => byId.has(l.componentId))
        .map((l, i) => {
          const c = byId.get(l.componentId)!;
          return { ...c, sortOrder: i, calcType: l.calcType, value: l.value };
        }),
    [lines, byId]
  );
  const problems = validateTemplateLines(templateLines);
  const sample = useMemo(
    () => (problems.length === 0 && Number(sampleCtc) > 0 ? computeSalaryLines(templateLines, Number(sampleCtc)) : null),
    [templateLines, sampleCtc, problems.length]
  );

  const update = (i: number, patch: Partial<EditorLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <form action={action} className="space-y-5">
      {initial?.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />

      <fieldset disabled={!canEdit} className="contents">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Structure name" className="sm:col-span-1">
            <input name="name" required defaultValue={initial?.name} placeholder="e.g. Manager" className={inputClass} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <input name="description" defaultValue={initial?.description} placeholder="Who is this structure for?" className={inputClass} />
          </Field>
        </div>

        <div className="overflow-hidden rounded-xl border border-line">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-canvas/60 text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2.5 font-semibold">Component</th>
                <th className="px-3 py-2.5 font-semibold">How it is worked out</th>
                <th className="px-3 py-2.5 font-semibold">Value</th>
                <th className="px-3 py-2.5 text-right font-semibold">Sample</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const c = byId.get(l.componentId);
                const amount = sample?.lines.find((s) => s.code === c?.code)?.monthlyAmount;
                return (
                  <tr key={l.componentId} className="border-t border-line/70">
                    <td className="px-3 py-2 font-medium text-ink">
                      {c?.name ?? "(removed)"}
                      {c?.isBasic && <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-semibold text-brand-700">Basic</span>}
                    </td>
                    <td className="px-3 py-2">
                      <select value={l.calcType} onChange={(e) => update(i, { calcType: e.target.value as CalcType })} className={cx(inputCompact, "w-64")} aria-label={`${c?.name} calculation`}>
                        {(Object.keys(CALC_LABEL) as CalcType[])
                          .filter((k) => !c?.isBasic || (k !== "PERCENT_OF_BASIC" && k !== "BALANCE"))
                          .map((k) => (
                            <option key={k} value={k}>{CALC_LABEL[k]}</option>
                          ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {l.calcType === "BALANCE" ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <input type="number" step="0.01" min={0} value={l.value} onChange={(e) => update(i, { value: Number(e.target.value) })} className={cx(inputCompact, "w-28")} aria-label={`${c?.name} value`} />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{amount !== undefined ? inr(amount) : "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="text-xs font-medium text-rose-700 hover:underline" aria-label={`Remove ${c?.name}`}>
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              {lines.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-ink-muted">No components yet — add some below.</td></tr>}
              {sample && (
                <tr className="border-t border-line bg-canvas/40 font-semibold">
                  <td className="px-3 py-2.5" colSpan={3}>Gross per month</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{inr(sample.grossMonthly)}</td>
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {unused.length > 0 && (
            <Field label="Add a component">
              <select
                value=""
                onChange={(e) => {
                  const c = byId.get(e.target.value);
                  if (c) setLines((ls) => [...ls, { componentId: c.id, calcType: c.isBasic ? "PERCENT_OF_CTC" : "FIXED", value: 0 }]);
                }}
                className={cx(inputClass, "w-60")}
              >
                <option value="">Choose…</option>
                {unused.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Sample CTC (₹ / year)" hint="Only for this preview.">
            <input type="number" min={1} value={sampleCtc} onChange={(e) => setSampleCtc(e.target.value)} className={cx(inputClass, "w-44")} />
          </Field>
          <label className="flex items-center gap-2 pb-2.5 text-sm text-ink">
            <input name="active" type="checkbox" defaultChecked={initial?.active ?? true} className="size-4 rounded border-line accent-brand-600" /> Available for new salaries
          </label>
        </div>

        {problems.length > 0 && lines.length > 0 && <Alert tone="error">{problems.join(". ")}.</Alert>}
        {sample?.warnings.map((w) => (
          <Alert key={w} tone="warning">{w}</Alert>
        ))}
      </fieldset>

      {canEdit && (
        <button type="submit" disabled={problems.length > 0} className={buttonClass("primary")}>
          <Icon name="check" className="size-4" />
          {submitLabel}
        </button>
      )}
    </form>
  );
}
