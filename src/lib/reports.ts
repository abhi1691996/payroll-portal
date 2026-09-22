import type { PayrollBreakdown } from "@/lib/payroll-calculations";

export interface PayslipForReport {
  employee: {
    employeeCode: string;
    firstName: string;
    lastName: string;
    panNumber: string | null;
  };
  breakdown: PayrollBreakdown;
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

export function buildPfReportCsv(payslips: PayslipForReport[]): string {
  return toCsv(
    ["Employee Code", "Name", "Employee PF", "Employer PF", "Total PF"],
    payslips.map((p) => [
      p.employee.employeeCode,
      `${p.employee.firstName} ${p.employee.lastName}`,
      p.breakdown.employeeDeductions.providentFund,
      p.breakdown.employerContributions.providentFund,
      round2(
        p.breakdown.employeeDeductions.providentFund +
          p.breakdown.employerContributions.providentFund
      ),
    ])
  );
}

export function buildEsiReportCsv(payslips: PayslipForReport[]): string {
  return toCsv(
    ["Employee Code", "Name", "Gross Pay", "Employee ESI", "Employer ESI"],
    payslips.map((p) => [
      p.employee.employeeCode,
      `${p.employee.firstName} ${p.employee.lastName}`,
      p.breakdown.grossPay,
      p.breakdown.employeeDeductions.esi,
      p.breakdown.employerContributions.esi,
    ])
  );
}

export function buildProfessionalTaxReportCsv(payslips: PayslipForReport[]): string {
  return toCsv(
    ["Employee Code", "Name", "Gross Pay", "Professional Tax"],
    payslips.map((p) => [
      p.employee.employeeCode,
      `${p.employee.firstName} ${p.employee.lastName}`,
      p.breakdown.grossPay,
      p.breakdown.employeeDeductions.professionalTax,
    ])
  );
}

export function buildTdsReportCsv(payslips: PayslipForReport[]): string {
  return toCsv(
    ["Employee Code", "Name", "PAN", "Gross Pay", "TDS Deducted"],
    payslips.map((p) => [
      p.employee.employeeCode,
      `${p.employee.firstName} ${p.employee.lastName}`,
      p.employee.panNumber ?? "",
      p.breakdown.grossPay,
      p.breakdown.employeeDeductions.tds,
    ])
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
