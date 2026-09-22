import { describe, expect, it } from "vitest";
import {
  calculateMonthlyPayroll,
  calculateProfessionalTax,
  calculateSlabTax,
  type StatutoryConfigInput,
} from "./payroll-calculations";

// FY2024-25-style config used for hand-computed fixtures below.
const config: StatutoryConfigInput = {
  pfEmployeeRate: 0.12,
  pfEmployerRate: 0.12,
  pfWageCeiling: 15000,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  esiWageThreshold: 21000,
  professionalTaxSlabs: [
    { upTo: 15000, amount: 0 },
    { upTo: 25000, amount: 150 },
    { upTo: null, amount: 200 },
  ],
  incomeTaxSlabs: {
    NEW: [
      { upTo: 300000, rate: 0 },
      { upTo: 600000, rate: 0.05 },
      { upTo: 900000, rate: 0.1 },
      { upTo: 1200000, rate: 0.15 },
      { upTo: 1500000, rate: 0.2 },
      { upTo: null, rate: 0.3 },
    ],
    OLD: [
      { upTo: 250000, rate: 0 },
      { upTo: 500000, rate: 0.05 },
      { upTo: 1000000, rate: 0.2 },
      { upTo: null, rate: 0.3 },
    ],
  },
};

describe("calculateSlabTax", () => {
  it("applies 0% for income entirely within the first slab", () => {
    expect(calculateSlabTax(250000, config.incomeTaxSlabs.NEW)).toBe(0);
  });

  it("applies marginal rates across multiple slabs", () => {
    // 700,000 under NEW regime: 0 on first 300k, 5% on next 300k (=15,000), 10% on remaining 100k (=10,000)
    const tax = calculateSlabTax(700000, config.incomeTaxSlabs.NEW);
    expect(tax).toBeCloseTo(25000, 2);
  });

  it("applies the top marginal rate to income above the last bound", () => {
    // 1,600,000: slabs sum to 0 + 15000 + 30000 + 45000 + 60000 = 150000, plus 30% of the remaining 100,000 = 30,000
    const tax = calculateSlabTax(1600000, config.incomeTaxSlabs.NEW);
    expect(tax).toBeCloseTo(180000, 2);
  });
});

describe("calculateProfessionalTax", () => {
  it("returns 0 for gross at or below the first slab", () => {
    expect(calculateProfessionalTax(15000, config.professionalTaxSlabs)).toBe(0);
  });

  it("returns the mid slab amount", () => {
    expect(calculateProfessionalTax(20000, config.professionalTaxSlabs)).toBe(150);
  });

  it("returns the top slab amount for gross above all bounds", () => {
    expect(calculateProfessionalTax(50000, config.professionalTaxSlabs)).toBe(200);
  });
});

describe("calculateMonthlyPayroll", () => {
  // Fixture: CTC ~600,000/yr employee, full attendance, no LOP.
  // Basic 20,000 + HRA 8,000 + Special 12,000 + Other 0 = Gross 40,000/month.
  const salary = {
    basicMonthly: 20000,
    hraMonthly: 8000,
    specialAllowance: 12000,
    otherAllowances: 0,
    employerPfOptIn: true,
    taxRegime: "NEW" as const,
  };

  it("computes full-attendance payroll with no LOP", () => {
    const result = calculateMonthlyPayroll(
      salary,
      { daysInPeriod: 30, paidDays: 30 },
      config
    );

    expect(result.grossPay).toBe(40000);
    expect(result.lopDays).toBe(0);
    // PF wage capped at ceiling: 15,000 x 12% = 1,800 (both employee and employer)
    expect(result.employeeDeductions.providentFund).toBe(1800);
    expect(result.employerContributions.providentFund).toBe(1800);
    // Gross 40,000 > ESI threshold 21,000 -> not ESI eligible
    expect(result.employeeDeductions.esi).toBe(0);
    expect(result.employerContributions.esi).toBe(0);
    // Professional tax top slab for gross > 25,000
    expect(result.employeeDeductions.professionalTax).toBe(200);
    // Annualized gross 480,000 -> 0 on first 300k, 5% on remaining 180k = 9,000/yr -> 750/month
    expect(result.employeeDeductions.tds).toBeCloseTo(750, 2);

    const expectedTotalDeductions =
      1800 + 0 + 200 + 750;
    expect(result.totalDeductions).toBeCloseTo(expectedTotalDeductions, 2);
    expect(result.netPay).toBeCloseTo(40000 - expectedTotalDeductions, 2);
  });

  it("prorates earnings and PF wage for loss-of-pay days", () => {
    // 2 LOP days out of a 30-day month -> paid for 28/30 of the month.
    const result = calculateMonthlyPayroll(
      salary,
      { daysInPeriod: 30, paidDays: 28 },
      config
    );

    expect(result.lopDays).toBe(2);
    // Basic prorated: 20,000 * 28/30 = 18,666.67
    expect(result.earnings.basic).toBeCloseTo(18666.67, 1);
    // Gross prorated: 40,000 * 28/30 = 37,333.33
    expect(result.grossPay).toBeCloseTo(37333.33, 1);
    // PF wage is prorated basic capped at ceiling: min(18,666.67, 15,000) = 15,000 -> unchanged
    expect(result.employeeDeductions.providentFund).toBe(1800);
  });

  it("applies ESI when prorated gross falls at or below the threshold", () => {
    const lowerSalary = {
      ...salary,
      specialAllowance: 5000, // gross now 33,000 full-month
    };
    // Enough LOP to bring gross under the 21,000 ESI threshold.
    const result = calculateMonthlyPayroll(
      lowerSalary,
      { daysInPeriod: 30, paidDays: 18 },
      config
    );

    // Gross: 33,000 * 18/30 = 19,800 <= 21,000 threshold
    expect(result.grossPay).toBeCloseTo(19800, 1);
    expect(result.employeeDeductions.esi).toBeCloseTo(19800 * 0.0075, 2);
    expect(result.employerContributions.esi).toBeCloseTo(19800 * 0.0325, 2);
  });

  it("skips PF entirely when the employee has opted out", () => {
    const optedOut = { ...salary, employerPfOptIn: false };
    const result = calculateMonthlyPayroll(
      optedOut,
      { daysInPeriod: 30, paidDays: 30 },
      config
    );

    expect(result.employeeDeductions.providentFund).toBe(0);
    expect(result.employerContributions.providentFund).toBe(0);
  });
});
