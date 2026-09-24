import ExcelJS from "exceljs";
import type { SalaryLine } from "@/lib/salary/compute";

/**
 * One wide "master sheet" row per employee (every status, not just active) plus their current salary
 * summary, and a second sheet with the itemised component breakdown. Not historical — the "current
 * salary" columns reflect whichever EmployeeSalary row is effective today (or was, for someone who's left).
 */

export interface MasterSheetEmployee {
  employeeCode: string;
  firstName: string;
  lastName: string;
  gender: string | null;
  dateOfBirth: Date | null;
  maritalStatus: string | null;
  bloodGroup: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  category: string;
  department: string | null;
  designation: string | null;
  managerName: string | null;
  dateOfJoining: Date;
  dateOfExit: Date | null;
  status: string;
  state: string;
  personalEmail: string | null;
  phone: string | null;
  loginEmail: string | null;
  panNumber: string | null;
  aadhaarLast4: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  taxRegime: string;
  currentSalary: {
    ctcAnnual: number;
    grossMonthly: number;
    employerPfOptIn: boolean;
    effectiveFrom: Date;
    lines: SalaryLine[];
  } | null;
}

const yesNo = (b: boolean) => (b ? "Yes" : "No");
const titled = (v: string | null) => (v ? v.charAt(0) + v.slice(1).toLowerCase() : "");

export async function buildEmployeeMasterSheet(employees: MasterSheetEmployee[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Payroll Portal";
  wb.created = new Date();

  const master = wb.addWorksheet("Employee Master");
  master.columns = [
    { header: "Employee Code", key: "employeeCode", width: 14 },
    { header: "First Name", key: "firstName", width: 16 },
    { header: "Last Name", key: "lastName", width: 16 },
    { header: "Gender", key: "gender", width: 10 },
    { header: "Date of Birth", key: "dateOfBirth", width: 14 },
    { header: "Marital Status", key: "maritalStatus", width: 14 },
    { header: "Blood Group", key: "bloodGroup", width: 12 },
    { header: "Emergency Contact Name", key: "emergencyContactName", width: 22 },
    { header: "Emergency Contact Phone", key: "emergencyContactPhone", width: 20 },
    { header: "Category", key: "category", width: 14 },
    { header: "Department", key: "department", width: 16 },
    { header: "Designation", key: "designation", width: 18 },
    { header: "Reporting Manager", key: "managerName", width: 18 },
    { header: "Date of Joining", key: "dateOfJoining", width: 14 },
    { header: "Date of Exit", key: "dateOfExit", width: 14 },
    { header: "Status", key: "status", width: 12 },
    { header: "State", key: "state", width: 16 },
    { header: "Personal Email", key: "personalEmail", width: 24 },
    { header: "Phone", key: "phone", width: 16 },
    { header: "Login Email", key: "loginEmail", width: 26 },
    { header: "PAN", key: "panNumber", width: 14 },
    { header: "Aadhaar (last 4)", key: "aadhaarLast4", width: 14 },
    { header: "Bank Account Number", key: "bankAccountNumber", width: 20 },
    { header: "Bank IFSC", key: "bankIfsc", width: 14 },
    { header: "Tax Regime", key: "taxRegime", width: 12 },
    { header: "CTC Annual (Rs)", key: "ctcAnnual", width: 16 },
    { header: "Gross Monthly (Rs)", key: "grossMonthly", width: 18 },
    { header: "Employer PF Opt-in", key: "employerPfOptIn", width: 16 },
    { header: "Salary Effective From", key: "salaryEffectiveFrom", width: 18 },
  ];
  master.getRow(1).font = { bold: true };
  master.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  master.views = [{ state: "frozen", ySplit: 1 }];
  master.autoFilter = { from: "A1", to: `AC1` };

  for (const e of employees) {
    master.addRow({
      employeeCode: e.employeeCode,
      firstName: e.firstName,
      lastName: e.lastName,
      gender: titled(e.gender),
      dateOfBirth: e.dateOfBirth,
      maritalStatus: titled(e.maritalStatus),
      bloodGroup: e.bloodGroup ?? "",
      emergencyContactName: e.emergencyContactName ?? "",
      emergencyContactPhone: e.emergencyContactPhone ?? "",
      category: titled(e.category),
      department: e.department ?? "",
      designation: e.designation ?? "",
      managerName: e.managerName ?? "",
      dateOfJoining: e.dateOfJoining,
      dateOfExit: e.dateOfExit,
      status: titled(e.status),
      state: e.state,
      personalEmail: e.personalEmail ?? "",
      phone: e.phone ?? "",
      loginEmail: e.loginEmail ?? "",
      panNumber: e.panNumber ?? "",
      aadhaarLast4: e.aadhaarLast4 ?? "",
      bankAccountNumber: e.bankAccountNumber ?? "",
      bankIfsc: e.bankIfsc ?? "",
      taxRegime: e.taxRegime,
      ctcAnnual: e.currentSalary?.ctcAnnual ?? null,
      grossMonthly: e.currentSalary?.grossMonthly ?? null,
      employerPfOptIn: e.currentSalary ? yesNo(e.currentSalary.employerPfOptIn) : "",
      salaryEffectiveFrom: e.currentSalary?.effectiveFrom ?? null,
    });
  }
  for (const key of ["dateOfBirth", "dateOfJoining", "dateOfExit", "salaryEffectiveFrom"]) {
    master.getColumn(key).numFmt = "dd-mmm-yyyy";
  }
  for (const key of ["ctcAnnual", "grossMonthly"]) {
    master.getColumn(key).numFmt = "#,##0.00";
  }

  const components = wb.addWorksheet("Salary Components");
  components.columns = [
    { header: "Employee Code", key: "employeeCode", width: 14 },
    { header: "Employee Name", key: "name", width: 22 },
    { header: "Component Code", key: "code", width: 16 },
    { header: "Component Name", key: "componentName", width: 20 },
    { header: "Monthly Amount (Rs)", key: "amount", width: 18 },
    { header: "Is Basic", key: "isBasic", width: 10 },
    { header: "Taxable", key: "taxable", width: 10 },
    { header: "Include in PF", key: "includeInPf", width: 12 },
    { header: "Include in ESI", key: "includeInEsi", width: 12 },
    { header: "Include in PT", key: "includeInPt", width: 12 },
  ];
  components.getRow(1).font = { bold: true };
  components.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  components.views = [{ state: "frozen", ySplit: 1 }];

  for (const e of employees) {
    if (!e.currentSalary) continue;
    for (const line of e.currentSalary.lines) {
      components.addRow({
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`.trim(),
        code: line.code,
        componentName: line.name,
        amount: line.monthlyAmount,
        isBasic: yesNo(line.isBasic),
        taxable: yesNo(line.taxable),
        includeInPf: yesNo(line.includeInPf),
        includeInEsi: yesNo(line.includeInEsi),
        includeInPt: yesNo(line.includeInPt),
      });
    }
  }
  components.getColumn("amount").numFmt = "#,##0.00";

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
