import { toCsv } from "../csv";
import type { BulkFileKey } from "./types";

export interface BulkTemplate {
  /** Download filename (without extension). */
  filename: string;
  headers: string[];
  sample: string[][];
}

export const TEMPLATES: Record<Exclude<BulkFileKey, "attendance-grid">, BulkTemplate> = {
  employees: {
    filename: "employees-template",
    headers: [
      "employeeCode",
      "firstName",
      "lastName",
      "email",
      "dateOfJoining",
      "state",
      "department",
      "designation",
      "phone",
      "personalEmail",
      "panNumber",
      "aadhaarLast4",
      "bankAccountNumber",
      "bankIfsc",
      "taxRegime",
      "tempPassword",
    ],
    sample: [
      ["EMP101", "Anita", "Desai", "anita.desai@acme.test", "2025-04-01", "Karnataka", "Finance", "Accountant", "9876543210", "anita@example.com", "ABCDE1234F", "4321", "123456789012", "HDFC0001234", "NEW", ""],
      ["EMP102", "Karan", "Mehta", "karan.mehta@acme.test", "15/04/2025", "Maharashtra", "Sales", "Executive", "", "", "", "", "", "", "OLD", ""],
    ],
  },
  // The salary template is built per company from its own components (see buildSalaryTemplate in exports.ts);
  // this entry is only the fallback shape.
  salary: {
    filename: "salaries-template",
    headers: ["employeeCode", "effectiveFrom", "ctcAnnual", "structure", "employerPfOptIn", "taxRegime"],
    sample: [["EMP101", "2025-04-01", "600000", "Standard", "YES", "NEW"]],
  },
  attendance: {
    filename: "attendance-daily-template",
    headers: ["employeeCode", "date", "status", "inTime", "outTime"],
    sample: [
      ["EMP101", "2025-04-01", "", "09:28 AM", "06:35 PM"],
      ["EMP101", "2025-04-02", "A", "", ""],
      ["EMP102", "2025-04-01", "", "10:05", "19:10"],
      ["EMP103", "2025-04-01", "", "10:00 PM", "06:05 AM"],
    ],
  },
  "leave-requests": {
    filename: "leave-requests-template",
    headers: ["employeeCode", "leaveType", "startDate", "endDate", "status", "reason"],
    sample: [
      ["EMP101", "Casual Leave", "2025-04-10", "2025-04-11", "APPROVED", "Family function"],
      ["EMP102", "Sick Leave", "2025-04-15", "2025-04-15", "APPROVED", ""],
    ],
  },
  "leave-balances": {
    filename: "leave-balances-template",
    headers: ["employeeCode", "leaveType", "balance", "asOf"],
    sample: [
      ["EMP101", "Casual Leave", "7.5", ""],
      ["EMP101", "Sick Leave", "8", "2025-04-01"],
    ],
  },
};

export function buildTemplateCsv(key: Exclude<BulkFileKey, "attendance-grid">): { filename: string; csv: string } {
  const t = TEMPLATES[key];
  return { filename: t.filename, csv: toCsv(t.headers, t.sample) };
}

export const BULK_FILE_KEYS: BulkFileKey[] = [
  "employees",
  "salary",
  "attendance",
  "attendance-grid",
  "leave-requests",
  "leave-balances",
];
