"use server";

import { revalidatePath } from "next/cache";
import { getContext } from "@/server/rbac/guard";
import { can, type TenantCtx } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { IMPORT_PERMISSION } from "@/lib/bulk/permissions";
import { parseCsvRecords } from "@/lib/csv";
import { IMPORTERS, REVALIDATE_PATHS } from "@/lib/bulk/importers";
import { BulkInputError, type BulkActionState, type BulkKind } from "@/lib/bulk/types";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ISSUES_RETURNED = 200;

function failure(message: string, kind?: BulkKind, fileName?: string): BulkActionState {
  return { status: "error", message, kind, fileName, total: 0, valid: 0, issues: [], warnings: [] };
}

/**
 * Single entry point for every bulk upload. `intent` is "validate" (dry run: parse and
 * check, write nothing) or "import" (re-check against the current database, then write).
 * Re-validating on import means a stale preview can never push bad data in.
 */
export async function runBulkImport(
  _prev: BulkActionState,
  formData: FormData
): Promise<BulkActionState> {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) return failure("Sign in as a company user to upload data.");
  const tenantCtx = ctx as TenantCtx;

  const kind = formData.get("kind");
  if (typeof kind !== "string" || !(kind in IMPORTERS)) return failure("Unknown upload type.");
  const importer = IMPORTERS[kind as BulkKind];
  if (!can(ctx, IMPORT_PERMISSION[kind as BulkKind], "COMPANY")) {
    return failure("You don't have permission to upload this kind of data.");
  }

  const intent = formData.get("intent") === "import" ? "import" : "validate";

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return failure("Choose a CSV file first.", kind as BulkKind);
  }
  if (file.size > MAX_FILE_BYTES) {
    return failure("That file is larger than 4 MB. Split it into smaller files.", kind as BulkKind, file.name);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // .xlsx/.xls are zip/OLE containers, not text. Give an actionable message, not garbled parsing.
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf;
  if (isZip || isOle) {
    return failure(
      "That looks like an Excel workbook. In Excel choose File → Save As → “CSV UTF-8 (Comma delimited)”, then upload the .csv.",
      kind as BulkKind,
      file.name
    );
  }

  const { headers, records } = parseCsvRecords(new TextDecoder("utf-8").decode(bytes));
  if (headers.length === 0 || records.length === 0) {
    return failure("The file has no data rows below the header.", kind as BulkKind, file.name);
  }

  const missing = importer.required
    .map((h, i) => ({ h, label: importer.requiredLabels?.[i] ?? h }))
    .filter(({ h }) => !headers.includes(h))
    .map(({ label }) => label);
  if (missing.length > 0) {
    return failure(
      `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the template to see the expected layout.`,
      kind as BulkKind,
      file.name
    );
  }

  if (records.length > importer.maxRows) {
    return failure(
      `This file has ${records.length.toLocaleString("en-IN")} rows; the limit for this upload is ${importer.maxRows.toLocaleString("en-IN")}. Split it into smaller files.`,
      kind as BulkKind,
      file.name
    );
  }

  const params: Record<string, string> = {};
  for (const key of ["year", "month"]) {
    const value = formData.get(key);
    if (typeof value === "string") params[key] = value;
  }

  try {
    // Validate (and, for "import", write) inside ONE tenant transaction: nothing can touch another
    // company, and a failure part-way leaves no partial import behind.
    const outcome = await withTenant(
      tenantCtx.companyId,
      async (db) => {
        const plan = await importer.plan({ headers, records, ctx: { actor: tenantCtx, params }, db });
        if (intent === "validate" || plan.valid === 0) return { plan, result: null };
        return { plan, result: await plan.commit() };
      },
      { timeout: 180_000 }
    );
    const { plan, result } = outcome;

    const base = {
      kind: kind as BulkKind,
      fileName: file.name,
      total: plan.total,
      valid: plan.valid,
      issues: plan.issues.slice(0, MAX_ISSUES_RETURNED),
      warnings: plan.warnings.slice(0, MAX_ISSUES_RETURNED),
      preview: plan.preview,
      summary: plan.summary,
    };

    if (intent === "validate") return { status: "preview", ...base };

    if (plan.valid === 0) {
      return {
        ...base,
        status: "error",
        message: "There are no valid rows to import — fix the errors below and try again.",
      };
    }

    for (const path of REVALIDATE_PATHS[kind as BulkKind]) revalidatePath(path);

    return {
      status: "imported",
      ...base,
      imported: result!.imported,
      updated: result!.updated,
      credentials: result!.credentials,
    };
  } catch (err) {
    if (err instanceof BulkInputError) return failure(err.message, kind as BulkKind, file.name);

    console.error("[bulk-import]", kind, err);
    return failure(
      intent === "import"
        ? "The import failed and nothing was saved. Please try again; if it keeps failing, check the server log."
        : "Couldn't check that file. Compare it with the template and try again.",
      kind as BulkKind,
      file.name
    );
  }
}
