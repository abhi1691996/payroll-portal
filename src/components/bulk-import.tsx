"use client";

import { startTransition, useActionState, useRef, useState, type DragEvent, type ReactNode } from "react";
import { runBulkImport } from "@/app/(dashboard)/bulk/actions";
import { toCsv } from "@/lib/csv";
import { INITIAL_BULK_STATE, type BulkActionState, type BulkIssue, type BulkKind } from "@/lib/bulk/types";
import { Icon } from "./icons";
import { Alert, Badge, buttonClass, cx } from "./ui";

interface DownloadLink {
  label: string;
  href: string;
}

export interface BulkImportProps {
  kind: BulkKind;
  title: string;
  description: string;
  /** Column list shown as a hint under the dropzone. */
  columnsHint: string;
  templates: DownloadLink[];
  exports?: DownloadLink[];
  /** Extra values sent with the file (e.g. year/month for the attendance grid). */
  params?: Record<string, string | number>;
  /** Page-specific tips shown above the dropzone. */
  children?: ReactNode;
  /** Word for one row of this upload, for button/summary text. */
  unit?: string;
}

function StatTile({ label, value, tone }: { label: string; value: number; tone: "slate" | "green" | "red" }) {
  const styles = {
    slate: "bg-canvas text-ink",
    green: "bg-emerald-50 text-emerald-800",
    red: value > 0 ? "bg-rose-50 text-rose-800" : "bg-canvas text-ink-muted",
  }[tone];
  return (
    <div className={cx("rounded-xl px-4 py-3", styles)}>
      <p className="text-2xl font-semibold tabular-nums">{value.toLocaleString("en-IN")}</p>
      <p className="text-xs font-medium opacity-80">{label}</p>
    </div>
  );
}

function IssueList({ title, tone, issues }: { title: string; tone: "error" | "warning"; issues: BulkIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <details className="group/issues rounded-xl border border-line" open={tone === "error"}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-ink">
        <Icon
          name={tone === "error" ? "error" : "warning"}
          className={cx("size-4", tone === "error" ? "text-rose-600" : "text-amber-600")}
        />
        {title}
        <Badge tone={tone === "error" ? "red" : "amber"}>{issues.length}</Badge>
        <Icon name="chevron-down" className="ml-auto size-4 text-ink-muted transition group-open/issues:rotate-180" />
      </summary>
      <ul className="thin-scroll max-h-64 divide-y divide-line/70 overflow-y-auto border-t border-line text-sm">
        {issues.map((issue) => (
          <li key={issue.line} className="flex gap-3 px-4 py-2.5">
            <span className="w-16 shrink-0 font-mono text-xs text-ink-muted">Row {issue.line}</span>
            <span className="text-ink-soft">{issue.messages.join(" · ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function BulkImport({
  kind,
  title,
  description,
  columnsHint,
  templates,
  exports = [],
  params = {},
  children,
  unit = "row",
}: BulkImportProps) {
  const [state, dispatch, pending] = useActionState<BulkActionState, FormData>(runBulkImport, INITIAL_BULK_STATE);
  const [file, setFile] = useState<File | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [running, setRunning] = useState<"validate" | "import" | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const plural = (n: number) => `${n.toLocaleString("en-IN")} ${unit}${n === 1 ? "" : "s"}`;

  function choose(next: File | null) {
    setFile(next);
    setShowResult(false); // a result belongs to the file it was produced from
  }

  function run(intent: "validate" | "import") {
    if (!file) return;
    // Build the FormData ourselves instead of using <form action>: React resets uncontrolled
    // form fields after an action, which would empty the file input between "Check" and "Import".
    const data = new FormData();
    data.set("kind", kind);
    data.set("intent", intent);
    data.set("file", file);
    for (const [key, value] of Object.entries(params)) data.set(key, String(value));
    setRunning(intent);
    setShowResult(true);
    startTransition(() => dispatch(data));
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) choose(dropped);
  }

  function downloadCredentials() {
    if (!state.credentials?.length) return;
    const csv = toCsv(
      ["employeeCode", "name", "email", "tempPassword"],
      state.credentials.map((c) => [c.employeeCode, c.name, c.email, c.tempPassword])
    );
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "new-employee-credentials.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const result = showResult && !pending ? state : null;
  const imported = result?.status === "imported";
  const canImport = result?.status === "preview" && result.valid > 0;

  return (
    <section className="fade-up rounded-2xl border border-line bg-surface shadow-card">
      <div className="flex flex-col gap-4 border-b border-line p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div className="flex gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
            <Icon name="upload" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            <p className="mt-0.5 max-w-xl text-sm text-ink-soft">{description}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {templates.map((t) => (
            <a key={t.href} href={t.href} className={buttonClass("secondary", "sm")}>
              <Icon name="sheet" className="size-4" />
              {t.label}
            </a>
          ))}
          {exports.map((t) => (
            <a key={t.href} href={t.href} className={buttonClass("ghost", "sm")}>
              <Icon name="download" className="size-4" />
              {t.label}
            </a>
          ))}
        </div>
      </div>

      <div className="space-y-4 p-5 sm:p-6">
        {children}

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition",
            "focus-within:ring-4 focus-within:ring-brand-100",
            dragging ? "border-brand-500 bg-brand-50" : "border-line bg-canvas/50 hover:border-brand-300 hover:bg-brand-50/50"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <>
              <Icon name="sheet" className="size-8 text-brand-600" />
              <p className="text-sm font-semibold text-ink">{file.name}</p>
              <p className="text-xs text-ink-muted">
                {(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB · click or drop to replace
              </p>
            </>
          ) : (
            <>
              <Icon name="upload" className="size-8 text-ink-muted" />
              <p className="text-sm font-medium text-ink">
                Drop a <span className="text-brand-700">.csv</span> file here, or click to browse
              </p>
              <p className="max-w-lg text-xs text-ink-muted">{columnsHint}</p>
            </>
          )}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => run("validate")}
            disabled={!file || pending}
            className={buttonClass(canImport ? "secondary" : "primary")}
          >
            {pending && running === "validate" ? "Checking…" : "Check file"}
          </button>
          {canImport && (
            <button type="button" onClick={() => run("import")} disabled={pending} className={buttonClass("primary")}>
              <Icon name="check" className="size-4" />
              {pending && running === "import" ? "Importing…" : `Import ${plural(result.valid)}`}
            </button>
          )}
          <p className="text-xs text-ink-muted">Nothing is saved until you press Import.</p>
        </div>

        {pending && (
          <p className="text-sm text-ink-soft" role="status">
            {running === "import"
              ? kind === "employees"
                ? "Creating logins — this can take a little while for large files…"
                : "Saving…"
              : "Reading and validating your file…"}
          </p>
        )}

        {result?.status === "error" && (
          <>
            <Alert tone="error">
              <p className="font-medium">{result.message}</p>
              {result.fileName && <p className="mt-0.5 text-xs opacity-80">{result.fileName}</p>}
            </Alert>
            <IssueList title="Rows with problems" tone="error" issues={result.issues} />
          </>
        )}

        {result && (result.status === "preview" || imported) && (
          <div className="space-y-4">
            {imported ? (
              <Alert tone="success">
                <p className="font-semibold">
                  Imported {plural(result.imported ?? 0)}
                  {result.updated ? ` and updated ${plural(result.updated)}` : ""}.
                </p>
                {result.valid < result.total && (
                  <p className="mt-0.5">
                    {plural(result.total - result.valid)} skipped because of the problems listed below.
                  </p>
                )}
              </Alert>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="In file" value={result.total} tone="slate" />
                <StatTile label="Ready to import" value={result.valid} tone="green" />
                <StatTile label="Will be skipped" value={result.total - result.valid} tone="red" />
              </div>
            )}

            {!imported && result.summary && result.valid > 0 && (
              <p className="text-sm text-ink-soft">
                <span className="font-medium text-ink">This will add:</span> {result.summary}.
              </p>
            )}

            {result.credentials && result.credentials.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                  <Icon name="warning" className="size-4" />
                  Temporary passwords were generated for {plural(result.credentials.length)}
                </p>
                <p className="mt-1 text-sm text-amber-900/80">
                  These are shown only once and can&apos;t be recovered later. Download them now and share each one
                  securely with the employee.
                </p>
                <button type="button" onClick={downloadCredentials} className={cx(buttonClass("primary", "sm"), "mt-3")}>
                  <Icon name="download" className="size-4" />
                  Download credentials CSV
                </button>
              </div>
            )}

            {result.preview && result.preview.rows.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-line">
                <p className="border-b border-line bg-canvas/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                  {imported ? "Imported" : "Preview"}
                  {result.preview.truncated ? " — first rows only" : ""}
                </p>
                <div className="thin-scroll overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-ink-muted">
                        {result.preview.columns.map((c) => (
                          <th key={c} className="whitespace-nowrap px-4 py-2 font-medium">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.preview.rows.map((row, i) => (
                        <tr key={i} className="border-t border-line/70">
                          {row.map((cell, j) => (
                            <td key={j} className="whitespace-nowrap px-4 py-2 text-ink-soft tabular-nums">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <IssueList
              title={imported ? "Rows that were skipped" : "Rows that will be skipped"}
              tone="error"
              issues={result.issues}
            />
            <IssueList title="Worth a second look" tone="warning" issues={result.warnings} />

            {imported && (
              <button
                type="button"
                className={buttonClass("secondary", "sm")}
                onClick={() => {
                  choose(null);
                  if (inputRef.current) inputRef.current.value = "";
                }}
              >
                Upload another file
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
