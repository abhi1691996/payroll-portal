"use client";

import { useMemo, useState } from "react";
import { computeSalaryLines, validateTemplateLines, type TemplateLineDef } from "@/lib/salary/compute";
import { Alert, Field, TextInput, buttonClass, inputClass } from "./ui";
import { Icon } from "./icons";

export interface TemplateOption {
  id: string;
  name: string;
  lines: TemplateLineDef[];
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Pick one of the company's salary structures, enter a CTC, and watch the components work out. Any amount can
 * be typed over; those are sent as `ov_<CODE>` and replace the structure's rule for that one employee.
 */
export function SalaryAssignForm({
  templates,
  action,
  defaultTemplateId,
  defaultCtc,
  defaultPf = true,
}: {
  templates: TemplateOption[];
  action: (formData: FormData) => void | Promise<void>;
  defaultTemplateId?: string;
  defaultCtc?: number;
  defaultPf?: boolean;
}) {
  const [templateId, setTemplateId] = useState(defaultTemplateId ?? templates[0]?.id ?? "");
  const [ctc, setCtc] = useState(defaultCtc ? String(defaultCtc) : "");
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const template = templates.find((t) => t.id === templateId);
  const problems = template ? validateTemplateLines(template.lines) : ["Choose a salary structure"];

  const numericOverrides = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(overrides)) if (v !== "" && Number.isFinite(Number(v))) out[k] = Number(v);
    return out;
  }, [overrides]);

  const base = useMemo(
    () => (template && Number(ctc) > 0 && problems.length === 0 ? computeSalaryLines(template.lines, Number(ctc)) : null),
    [template, ctc, problems.length]
  );
  const result = useMemo(
    () => (template && Number(ctc) > 0 && problems.length === 0 ? computeSalaryLines(template.lines, Number(ctc), numericOverrides) : null),
    [template, ctc, numericOverrides, problems.length]
  );

  if (templates.length === 0) {
    return (
      <Alert tone="warning">
        There is no salary structure yet. Create one under <b>Settings → Salary Rules</b> first.
      </Alert>
    );
  }

  return (
    <form action={action} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Salary structure">
          <select
            name="templateId"
            value={templateId}
            onChange={(e) => { setTemplateId(e.target.value); setOverrides({}); }}
            className={inputClass}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>
        <TextInput label="Effective from" name="effectiveFrom" type="date" required />
        <Field label="CTC (annual, ₹)">
          <input
            name="ctcAnnual" type="number" step="0.01" min="1" required value={ctc}
            onChange={(e) => setCtc(e.target.value)} className={inputClass}
          />
        </Field>
        <label className="flex items-center gap-3 self-end rounded-xl border border-line px-4 py-2.5 text-sm text-ink">
          <input name="employerPfOptIn" type="checkbox" defaultChecked={defaultPf} className="size-4 rounded border-line accent-brand-600" />
          Enrolled in Provident Fund
        </label>
      </div>

      {problems.length > 0 && template && <Alert tone="error">{problems.join(". ")}. Fix the structure under Settings → Salary Rules.</Alert>}

      {result && base && (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-canvas/60 text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="px-4 py-2.5 font-semibold">Component</th>
                <th className="px-4 py-2.5 text-right font-semibold">Monthly amount</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => {
                const overridden = l.code in numericOverrides;
                return (
                  <tr key={l.code} className="border-t border-line/70">
                    <td className="px-4 py-2 text-ink">
                      {l.name}
                      {overridden && <span className="ml-2 text-xs text-amber-700">adjusted</span>}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <input
                        type="number" step="0.01" min="0" aria-label={`${l.name} monthly amount`}
                        value={overrides[l.code] ?? String(l.monthlyAmount)}
                        onChange={(e) => {
                          const value = e.target.value;
                          const computed = base.lines.find((b) => b.code === l.code)?.monthlyAmount;
                          setOverrides((o) => {
                            const next = { ...o };
                            if (value === "" || Number(value) === computed) delete next[l.code];
                            else next[l.code] = value;
                            return next;
                          });
                        }}
                        className="w-36 rounded-lg border border-line px-2.5 py-1.5 text-right tabular-nums focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100"
                      />
                      {overridden && <input type="hidden" name={`ov_${l.code}`} value={overrides[l.code]} />}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-line bg-canvas/40 font-semibold">
                <td className="px-4 py-2.5">Gross monthly</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{inr(result.grossMonthly)}</td>
              </tr>
            </tbody>
          </table>
          {result.warnings.map((w) => (
            <p key={w} className="border-t border-line px-4 py-2 text-xs font-medium text-amber-800">{w}</p>
          ))}
        </div>
      )}

      <button type="submit" disabled={!result} className={buttonClass("primary")}>
        <Icon name="check" className="size-4" />
        Save salary
      </button>
    </form>
  );
}
