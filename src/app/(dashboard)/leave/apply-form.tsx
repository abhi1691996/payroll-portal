"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert, Field, buttonClass, cx, inputClass } from "@/components/ui";
import { Icon } from "@/components/icons";
import { applyLeaveAction, previewLeaveAction } from "./actions";
import type { LeavePreview } from "@/server/leave/service";

export interface LeaveTypeOption {
  id: string;
  name: string;
  isPaid: boolean;
  available: number | null;
}

/**
 * Apply for leave. As the dates change, the same checks that run on submit are run and shown: does the
 * policy allow it, how many days really count (holidays / weekly offs are skipped), any clash with existing
 * leave, and is there enough balance.
 */
export function LeaveApplyForm({ types }: { types: LeaveTypeOption[] }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [half, setHalf] = useState(false);
  // The result is stored with the inputs it was computed for, so stale results are never shown.
  const [result, setResult] = useState<{ key: string; value: LeavePreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  // Re-run the checks (debounced) whenever what the person chose changes.
  const key = typeId && from ? `${typeId}|${from}|${to || from}|${half}` : "";
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const value = await previewLeaveAction({ leaveTypeId: typeId, from, to: to || from, half });
      if (!cancelled) setResult({ key, value });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, typeId, from, to, half]);
  const preview = key && result?.key === key ? result.value : null;
  const checking = !!key && !preview;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    setDone(false);
    start(async () => {
      const result = await applyLeaveAction(data);
      if (!result.ok) { setError(result.error ?? "Couldn't submit"); return; }
      setDone(true);
      setFrom(""); setTo(""); setHalf(false); setResult(null);
      formRef.current?.reset();
      router.refresh();
    });
  }

  const type = types.find((t) => t.id === typeId);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Leave type" className="sm:col-span-2">
          <select name="leaveTypeId" value={typeId} onChange={(e) => setTypeId(e.target.value)} required className={inputClass}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.available !== null ? ` — ${t.available} available` : t.isPaid ? "" : " (unpaid)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input name="from" type="date" required value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} className={inputClass} />
        </Field>
        <Field label="To">
          <input name="to" type="date" required value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </Field>
        <label className="flex items-center gap-3 text-sm text-ink sm:col-span-2">
          <input name="half" type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} className="size-4 rounded border-line accent-brand-600" />
          Half day (single date only)
        </label>
        <Field label="Reason" className="sm:col-span-2">
          <textarea name="reason" rows={2} className={inputClass} placeholder="e.g. Personal work" />
        </Field>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-semibold text-ink">System checks</p>
        {!preview && !checking && <p className="text-sm text-ink-muted">Choose the dates and we&apos;ll check your balance, holidays and existing leave.</p>}
        {checking && <p className="text-sm text-ink-muted" role="status">Checking…</p>}
        {preview && !checking && (
          <div className={cx("space-y-2 rounded-xl border p-4 text-sm", preview.ok ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50")}>
            <p className={cx("flex items-center gap-2 font-semibold", preview.ok ? "text-emerald-800" : "text-rose-800")}>
              <Icon name={preview.ok ? "check" : "error"} className="size-4" />
              {preview.ok ? `${preview.days} day${preview.days === 1 ? "" : "s"} will be counted` : "This can't be submitted yet"}
            </p>
            {preview.errors.map((e) => (
              <p key={e} className="text-rose-800">• {e}</p>
            ))}
            {preview.notes.map((n) => (
              <p key={n} className="text-ink-soft">• {n}</p>
            ))}
            {preview.ok && preview.available !== undefined && type?.isPaid && (
              <p className="text-ink-soft">• Balance after approval: <b className="font-medium text-ink">{Math.round((preview.available - preview.days) * 100) / 100}</b> days</p>
            )}
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {done && <Alert tone="success">Submitted. It has gone to your approver.</Alert>}
        <button type="submit" disabled={pending || !preview?.ok} className={buttonClass("primary")}>
          <Icon name="check" className="size-4" />
          {pending ? "Submitting…" : "Submit request"}
        </button>
      </div>
    </form>
  );
}
