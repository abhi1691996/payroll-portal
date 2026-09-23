export type TaxRegime = "OLD" | "NEW";

export interface TaxSlab {
  /** Upper bound of this slab's income (inclusive), or null for "and above". */
  upTo: number | null;
  /** Marginal rate applied to the portion of income within this slab, e.g. 0.05 for 5%. */
  rate: number;
}

export interface ProfessionalTaxSlab {
  /** Upper bound of monthly gross for this slab (inclusive), or null for "and above". */
  upTo: number | null;
  amount: number;
}

export interface StatutoryConfigInput {
  pfEmployeeRate: number;
  pfEmployerRate: number;
  pfWageCeiling: number;
  esiEmployeeRate: number;
  esiEmployerRate: number;
  esiWageThreshold: number;
  professionalTaxSlabs: ProfessionalTaxSlab[];
  incomeTaxSlabs: Record<TaxRegime, TaxSlab[]>;
}

export interface SalaryStructureInput {
  basicMonthly: number;
  hraMonthly: number;
  specialAllowance: number;
  otherAllowances: number;
  employerPfOptIn: boolean;
  taxRegime: TaxRegime;
}

export interface AttendanceInput {
  /** Total calendar days in the pay period (typically the days in the month). */
  daysInPeriod: number;
  /** Days the employee is actually paid for (daysInPeriod minus LOP days). */
  paidDays: number;
}

/** One earning component of an employee's salary, with the flags that decide how statutory maths treats it. */
export interface EarningLineInput {
  code: string;
  name: string;
  monthlyAmount: number;
  isBasic?: boolean;
  taxable: boolean;
  includeInPf: boolean;
  includeInEsi: boolean;
  includeInPt: boolean;
  /** Default true: scaled down for loss-of-pay days. Overtime is paid as earned, so it sets this to false. */
  prorate?: boolean;
}

export interface PayrollLinesInput {
  lines: EarningLineInput[];
  employerPfOptIn: boolean;
  taxRegime: TaxRegime;
}

export interface PayrollBreakdown {
  /** Per-component earnings after loss-of-pay proration. Present on payslips produced by the component engine. */
  earningLines?: { code: string; name: string; amount: number }[];
  /** Legacy fixed-key view (Basic / HRA / Special / everything else), kept so older payslips and reports keep working. */
  earnings: {
    basic: number;
    hra: number;
    specialAllowance: number;
    otherAllowances: number;
  };
  lopDays: number;
  /** How the loss-of-pay figure was reached, recorded with the payslip so it can be explained later. */
  attendanceSummary?: {
    absentDays: number;
    halfDays: number;
    unpaidLeaveDays: number;
    lateMarks: number;
    lateHalfDays: number;
    overtimeMinutes: number;
    /** Unpaid days that were suspended, or fell after the employee's last working day. Not "loss of pay" — the days simply weren't part of the payable period. */
    suspendedDays?: number;
    separatedDays?: number;
  };
  grossPay: number;
  employeeDeductions: {
    providentFund: number;
    esi: number;
    professionalTax: number;
    tds: number;
  };
  employerContributions: {
    providentFund: number;
    esi: number;
  };
  totalDeductions: number;
  netPay: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Applies loss-of-pay proration to a monthly salary component based on paid vs. total days.
 */
function prorate(monthlyAmount: number, attendance: AttendanceInput): number {
  if (attendance.daysInPeriod <= 0) return 0; // e.g. the whole month fell outside employment (suspended / separated)
  if (attendance.paidDays >= attendance.daysInPeriod) return monthlyAmount;
  return (monthlyAmount * attendance.paidDays) / attendance.daysInPeriod;
}

/**
 * Sequential (marginal) slab tax calculation: each slab's rate applies only to the
 * portion of income that falls within that slab, not the whole income.
 */
export function calculateSlabTax(annualIncome: number, slabs: TaxSlab[]): number {
  if (!Array.isArray(slabs) || slabs.length === 0) {
    // Malformed StatutoryConfig (e.g. hand-edited JSON in the wrong shape) — fail loudly and specifically
    // rather than as "slabs is not iterable" deep in a payroll run. See src/lib/validations/statutory.ts.
    throw new Error("Income tax slabs are missing or malformed for this period — check Settings -> Compliance rules.");
  }
  let tax = 0;
  let previousCap = 0;

  for (const slab of slabs) {
    const cap = slab.upTo ?? Infinity;
    if (annualIncome <= previousCap) break;
    const taxableInSlab = Math.min(annualIncome, cap) - previousCap;
    tax += taxableInSlab * slab.rate;
    previousCap = cap;
  }

  return tax;
}

export function calculateProfessionalTax(
  monthlyGross: number,
  slabs: ProfessionalTaxSlab[]
): number {
  for (const slab of slabs) {
    if (slab.upTo === null || monthlyGross <= slab.upTo) {
      return slab.amount;
    }
  }
  return 0;
}

/**
 * Computes one employee's monthly payroll breakdown.
 *
 * Simplifications acknowledged for MVP (verify with the company's CA before go-live):
 * - TDS is estimated by annualizing this month's gross pay (gross x 12) and applying slabs,
 *   rather than the cumulative projected-income method payroll software normally uses across
 *   the financial year. It does not account for standard deduction, HRA/80C exemptions, or
 *   income from other sources — treat it as an estimate, not a filing-ready figure.
 * - ESI eligibility is checked against this month's gross rather than the gross at the start
 *   of the ESI contribution period (Apr-Sep / Oct-Mar), which is how ESI actually determines
 *   continued eligibility once enrolled.
 */
export function calculateMonthlyPayroll(
  salary: SalaryStructureInput,
  attendance: AttendanceInput,
  config: StatutoryConfigInput
): PayrollBreakdown {
  // The original four fixed components, expressed as component lines.
  const line = (code: string, name: string, amount: number, isBasic = false, pf = false): EarningLineInput => ({
    code, name, monthlyAmount: amount, isBasic, taxable: true, includeInPf: pf, includeInEsi: true, includeInPt: true,
  });
  return calculatePayrollFromLines(
    {
      lines: [
        line("BASIC", "Basic", salary.basicMonthly, true, true),
        line("HRA", "HRA", salary.hraMonthly),
        line("SPECIAL", "Special Allowance", salary.specialAllowance),
        line("OTHER", "Other Allowances", salary.otherAllowances),
      ],
      employerPfOptIn: salary.employerPfOptIn,
      taxRegime: salary.taxRegime,
    },
    attendance,
    config
  );
}

/**
 * The general form: works from whatever components the company defined. Statutory wages come from the
 * flags on each component (PF on the components marked for PF, capped at the ceiling; ESI and Professional
 * Tax on the components marked for them; TDS on the taxable components).
 */
export function calculatePayrollFromLines(
  salary: PayrollLinesInput,
  attendance: AttendanceInput,
  config: StatutoryConfigInput
): PayrollBreakdown {
  const lopDays = Math.max(0, attendance.daysInPeriod - attendance.paidDays);

  const earned = salary.lines.map((l) => ({
    ...l,
    amount: l.prorate === false ? round2(l.monthlyAmount) : round2(prorate(l.monthlyAmount, attendance)),
  }));
  const sum = (pred: (l: (typeof earned)[number]) => boolean) => round2(earned.filter(pred).reduce((t, l) => t + l.amount, 0));

  const grossPay = sum(() => true);
  const pfWage = Math.min(sum((l) => l.includeInPf), config.pfWageCeiling);
  const employeePf = salary.employerPfOptIn ? round2(pfWage * config.pfEmployeeRate) : 0;
  const employerPf = salary.employerPfOptIn ? round2(pfWage * config.pfEmployerRate) : 0;

  const esiWage = sum((l) => l.includeInEsi);
  const esiEligible = esiWage <= config.esiWageThreshold;
  const employeeEsi = esiEligible ? round2(esiWage * config.esiEmployeeRate) : 0;
  const employerEsi = esiEligible ? round2(esiWage * config.esiEmployerRate) : 0;

  const professionalTax = round2(calculateProfessionalTax(sum((l) => l.includeInPt), config.professionalTaxSlabs));

  const annualTaxable = sum((l) => l.taxable) * 12;
  const tds = round2(calculateSlabTax(annualTaxable, config.incomeTaxSlabs[salary.taxRegime]) / 12);

  const totalDeductions = round2(employeePf + employeeEsi + professionalTax + tds);
  const netPay = round2(grossPay - totalDeductions);

  const basic = sum((l) => !!l.isBasic || l.code === "BASIC");
  const hra = sum((l) => l.code === "HRA");
  const special = sum((l) => l.code === "SPECIAL");

  return {
    earningLines: earned.map((l) => ({ code: l.code, name: l.name, amount: l.amount })),
    earnings: { basic, hra, specialAllowance: special, otherAllowances: round2(grossPay - basic - hra - special) },
    lopDays,
    grossPay,
    employeeDeductions: { providentFund: employeePf, esi: employeeEsi, professionalTax, tds },
    employerContributions: { providentFund: employerPf, esi: employerEsi },
    totalDeductions,
    netPay,
  };
}
