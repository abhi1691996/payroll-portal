/**
 * Works out an employee's monthly pay components from a salary template and a CTC.
 * Every company defines its own components and templates; this is the only place the arithmetic lives.
 */
export type CalcType = "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_CTC" | "BALANCE";

export interface ComponentFlags {
  code: string;
  name: string;
  isBasic: boolean;
  taxable: boolean;
  includeInPf: boolean;
  includeInEsi: boolean;
  includeInPt: boolean;
  sortOrder: number;
}

export interface TemplateLineDef extends ComponentFlags {
  calcType: CalcType;
  /** Rupees for FIXED; a percentage (40 = 40%) for the PERCENT_* types; ignored for BALANCE. */
  value: number;
}

export interface SalaryLine extends ComponentFlags {
  monthlyAmount: number;
}

export interface SalaryComputation {
  lines: SalaryLine[];
  grossMonthly: number;
  monthlyCtc: number;
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rules a template must satisfy to be computable. Returns human-readable problems (empty = valid). */
export function validateTemplateLines(lines: Pick<TemplateLineDef, "name" | "calcType" | "isBasic">[]): string[] {
  const errors: string[] = [];
  if (lines.length === 0) errors.push("Add at least one component");
  const basics = lines.filter((l) => l.isBasic);
  if (basics.length > 1) errors.push("Only one component can be the Basic");
  const basic = basics[0];
  if (basic && (basic.calcType === "PERCENT_OF_BASIC" || basic.calcType === "BALANCE")) {
    errors.push("The Basic component must be a fixed amount or a percentage of CTC");
  }
  if (!basic && lines.some((l) => l.calcType === "PERCENT_OF_BASIC")) {
    errors.push("A percentage of Basic needs a Basic component in the structure");
  }
  if (lines.filter((l) => l.calcType === "BALANCE").length > 1) errors.push("Only one component can be the balancing figure");
  return errors;
}

/**
 * @param overrides optional exact monthly amounts by component code (used when someone types an amount
 *   instead of accepting the template's rule).
 */
export function computeSalaryLines(
  template: TemplateLineDef[],
  ctcAnnual: number,
  overrides: Record<string, number> = {}
): SalaryComputation {
  const monthlyCtc = round2(ctcAnnual / 12);
  const warnings: string[] = [];
  const amounts = new Map<string, number>();

  const sorted = [...template].sort((a, b) => a.sortOrder - b.sortOrder);
  const overridden = (l: TemplateLineDef) => l.code in overrides && Number.isFinite(overrides[l.code]);

  // Pass 1: things that depend only on CTC (this includes the Basic).
  for (const l of sorted) {
    if (overridden(l)) amounts.set(l.code, round2(overrides[l.code]));
    else if (l.calcType === "FIXED") amounts.set(l.code, round2(l.value));
    else if (l.calcType === "PERCENT_OF_CTC") amounts.set(l.code, round2((monthlyCtc * l.value) / 100));
  }
  // Pass 2: percentages of Basic.
  const basic = sorted.find((l) => l.isBasic);
  const basicAmount = basic ? (amounts.get(basic.code) ?? 0) : 0;
  for (const l of sorted) {
    if (!amounts.has(l.code) && l.calcType === "PERCENT_OF_BASIC") amounts.set(l.code, round2((basicAmount * l.value) / 100));
  }
  // Pass 3: the balancing figure takes whatever CTC is left.
  const balance = sorted.find((l) => l.calcType === "BALANCE" && !overridden(l));
  if (balance) {
    const used = [...amounts.values()].reduce((s, v) => s + v, 0);
    const rest = round2(monthlyCtc - used);
    if (rest < 0) {
      warnings.push(
        `The other components (₹${used.toLocaleString("en-IN")}) exceed the monthly CTC (₹${monthlyCtc.toLocaleString("en-IN")}).`
      );
    }
    amounts.set(balance.code, Math.max(0, rest));
  }

  const lines: SalaryLine[] = sorted.map((l) => ({
    code: l.code,
    name: l.name,
    isBasic: l.isBasic,
    taxable: l.taxable,
    includeInPf: l.includeInPf,
    includeInEsi: l.includeInEsi,
    includeInPt: l.includeInPt,
    sortOrder: l.sortOrder,
    monthlyAmount: amounts.get(l.code) ?? 0,
  }));
  const grossMonthly = round2(lines.reduce((s, l) => s + l.monthlyAmount, 0));
  if (grossMonthly > monthlyCtc + 0.01) warnings.push("Gross pay is higher than the monthly CTC.");
  return { lines, grossMonthly, monthlyCtc, warnings };
}
