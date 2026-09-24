/**
 * India's statutory financial year for income tax / TDS purposes: always April 1 - March 31, regardless
 * of a company's own accounting `financialYearStart` setting (that field is for the company's books;
 * TDS withholding follows the Income Tax Act's year, full stop).
 */

export interface FyMonth {
  year: number;
  month: number;
}

/** Which FY a given payroll period falls in, expressed as the FY's starting calendar year (e.g. 2026 = FY 2026-27). */
export function financialYearOf(year: number, month: number): number {
  return month >= 4 ? year : year - 1;
}

export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The 12 (year, month) pairs of the FY, April through March, in order. */
export function fyMonths(startYear: number): FyMonth[] {
  const months: FyMonth[] = [];
  for (let m = 4; m <= 12; m++) months.push({ year: startYear, month: m });
  for (let m = 1; m <= 3; m++) months.push({ year: startYear + 1, month: m });
  return months;
}

/** A few financial years around today's (current + 1 down through current - (count - 2)) — for a "which year" picker. */
export function recentFinancialYears(count = 4): number[] {
  const now = new Date();
  const current = financialYearOf(now.getFullYear(), now.getMonth() + 1);
  return Array.from({ length: count }, (_, i) => current + 1 - i);
}
