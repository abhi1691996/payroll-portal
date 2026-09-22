import type { TenantCtx } from "@/server/rbac/context";
import type { TenantDb } from "@/server/tenancy/db";
import type { CsvRecord } from "../csv";

export type BulkKind =
  | "employees"
  | "salary"
  | "attendance"
  | "leave-requests"
  | "leave-balances";

/** Templates/exports have one more variant than importers: the monthly attendance grid. */
export type BulkFileKey = BulkKind | "attendance-grid";

/** Thrown by an importer for problems the user can fix themselves; the message is shown verbatim. */
export class BulkInputError extends Error {}

export interface BulkIssue {
  /** Line number in the uploaded sheet (header = line 1). */
  line: number;
  messages: string[];
}

export interface BulkPreview {
  columns: string[];
  rows: string[][];
  /** True when more rows exist than are shown. */
  truncated: boolean;
}

export interface BulkCredential {
  employeeCode: string;
  name: string;
  email: string;
  tempPassword: string;
}

export interface BulkCommitResult {
  imported: number;
  /** Rows that replaced existing data rather than adding new. */
  updated?: number;
  credentials?: BulkCredential[];
}

/** What an importer produces after checking a file, before anything is written. */
export interface BulkPlan {
  /** Data rows found in the file (excluding the header). */
  total: number;
  /** Rows that will be imported. */
  valid: number;
  /** Rows that will be skipped, with reasons. */
  issues: BulkIssue[];
  /** Rows that import fine but are worth a second look. */
  warnings: BulkIssue[];
  preview: BulkPreview;
  /** Optional one-line description of what the import will do. */
  summary?: string;
  commit: () => Promise<BulkCommitResult>;
}

export interface BulkContext {
  /** The signed-in company user running the import (used for audit and "decided by"). */
  actor: TenantCtx;
  /** Extra values posted alongside the file (e.g. year/month for the attendance grid). */
  params: Record<string, string>;
}

export interface BulkImporter {
  /** Headers (normalized) that must exist for the file to be readable at all. */
  required: string[];
  /** Human names for the required headers, used in error messages. */
  requiredLabels?: string[];
  maxRows: number;
  /**
   * `db` is the caller's tenant transaction: every read is limited to the company, and `commit`
   * writes inside the same transaction, so a failed import leaves nothing behind.
   */
  plan: (input: {
    headers: string[];
    records: CsvRecord[];
    ctx: BulkContext;
    db: TenantDb;
  }) => Promise<BulkPlan>;
}

/** Serializable result handed back to the client component. */
export interface BulkActionState {
  status: "idle" | "preview" | "imported" | "error";
  kind?: BulkKind;
  message?: string;
  fileName?: string;
  total: number;
  valid: number;
  issues: BulkIssue[];
  warnings: BulkIssue[];
  preview?: BulkPreview;
  summary?: string;
  imported?: number;
  updated?: number;
  credentials?: BulkCredential[];
}

export const INITIAL_BULK_STATE: BulkActionState = {
  status: "idle",
  total: 0,
  valid: 0,
  issues: [],
  warnings: [],
};
