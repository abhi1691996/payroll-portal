import type { BulkImporter, BulkKind } from "../types";
import { attendanceImporter } from "./attendance";
import { employeesImporter } from "./employees";
import { leaveBalancesImporter, leaveRequestsImporter } from "./leave";
import { salaryImporter } from "./salary";

export const IMPORTERS: Record<BulkKind, BulkImporter> = {
  employees: employeesImporter,
  salary: salaryImporter,
  attendance: attendanceImporter,
  "leave-requests": leaveRequestsImporter,
  "leave-balances": leaveBalancesImporter,
};

/** Pages whose cached data changes after each kind of import. */
export const REVALIDATE_PATHS: Record<BulkKind, string[]> = {
  employees: ["/employees", "/dashboard"],
  salary: ["/employees", "/employees/salary"],
  attendance: ["/attendance"],
  "leave-requests": ["/leave", "/dashboard"],
  "leave-balances": ["/leave"],
};
