import type { PermissionKey } from "@/server/rbac/permissions";
import type { BulkFileKey, BulkKind } from "./types";

/** What a user must hold to UPLOAD each kind of data. */
export const IMPORT_PERMISSION: Record<BulkKind, PermissionKey> = {
  employees: "employee.import",
  salary: "employee.salary.write",
  attendance: "attendance.import",
  "leave-requests": "leave.manage",
  "leave-balances": "leave.manage",
};

/** What a user must hold (company-wide) to DOWNLOAD a template or export. */
export const FILE_PERMISSION: Record<BulkFileKey, PermissionKey> = {
  employees: "employee.import",
  salary: "employee.salary.read",
  attendance: "attendance.read",
  "attendance-grid": "attendance.read",
  "leave-requests": "leave.manage",
  "leave-balances": "leave.manage",
};
