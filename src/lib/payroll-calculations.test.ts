import { describe, expect, it } from "vitest";
import {
  calculateMonthlyPayroll,
  calculateProfessionalTax,
  calculateSection87ARebate,
  calculateSlabTax,
  computeTdsComputation,
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

describe("calculateSection87ARebate", () => {
  it("old regime: full rebate (tax nil) exactly at the 5,00,000 threshold", () => {
    // Real old-regime slabs on 500,000 taxable: 0 on first 250k, 5% on next 250k = 12,500 tax —
    // which is exactly the old regime's rebate cap, so tax is wiped out completely.
    const tax = calculateSlabTax(500000, config.incomeTaxSlabs.OLD);
    expect(tax).toBe(12500);
    expect(calculateSection87ARebate(500000, "OLD", tax)).toBe(12500);
  });

  it("old regime: a single rupee over the threshold loses the whole rebate (no marginal relief)", () => {
    const tax = calculateSlabTax(500001, config.incomeTaxSlabs.OLD);
    expect(tax).toBeCloseTo(12500.2, 2);
    expect(calculateSection87ARebate(500001, "OLD", tax)).toBe(0);
  });

  it("new regime: full rebate (tax nil) up to the 12,00,000 threshold", () => {
    expect(calculateSection87ARebate(1200000, "NEW", 60000)).toBe(60000);
    expect(calculateSection87ARebate(900000, "NEW", 30000)).toBe(30000);
  });

  it("new regime: marginal relief tapers the rebate just above the threshold so tax never exceeds the excess income", () => {
    // 50,000 over the threshold; nominal tax 67,500 would be a worse outcome than paying tax only on
    // the excess (50,000), so the rebate absorbs the difference instead of cutting off abruptly.
    const rebate = calculateSection87ARebate(1250000, "NEW", 67500);
    expect(rebate).toBe(17500); // 67,500 - (1,250,000 - 1,200,000)
    expect(67500 - rebate).toBe(50000); // net tax equals exactly the excess over the threshold
  });

  it("new regime: marginal relief phases out once nominal tax is comfortably above the excess income", () => {
    const rebate = calculateSection87ARebate(2000000, "NEW", 250000);
    expect(rebate).toBe(0);
  });
});

describe("computeTdsComputation", () => {
  const slabs = config.incomeTaxSlabs.NEW;

  it("gross minus deductions gives taxable income, then slab tax minus rebate plus 4% cess gives the annual liability", () => {
    // 900,000 - 75,000 standard deduction = 825,000 taxable.
    // 0 on the first 300k, 5% on the next 300k (=15,000), 10% on the remaining 225k (=22,500) = 37,500 tax.
    // Old regime here (threshold 5L) so 87A doesn't apply at 825k taxable — rebate stays 0.
    // +4% cess (1,500) = 39,000 annual liability. Nothing deducted yet, 12 months left: 39,000/12 = 3,250/mo exactly.
    const r = computeTdsComputation({
      grossIncome: 900000,
      deductionLines: [{ code: "STD_DED", name: "Standard Deduction", amount: 75000 }],
      tdsAlreadyDeducted: 0,
      remainingMonths: 12,
      slabs,
      taxRegime: "OLD",
    });
    expect(r.totalDeductions).toBe(75000);
    expect(r.taxableIncome).toBe(825000);
    expect(r.taxLiability).toBeCloseTo(37500, 2);
    expect(r.rebate87A).toBe(0);
    expect(r.cess).toBeCloseTo(1500, 2);
    expect(r.annualTdsLiability).toBeCloseTo(39000, 2);
    expect(r.balanceTds).toBeCloseTo(39000, 2);
    expect(r.monthlyTds).toBe(3250);
  });

  it("balance TDS is annual liability minus what's already been deducted, spread over the months left — same shape as the request's worked example", () => {
    // A flat 10% slab keeps the tax math trivially checkable: 1,000,000 taxable x 10% = 100,000 tax,
    // +4% cess (4,000) = 104,000 annual liability. Old regime (threshold 5L) so 87A doesn't apply at
    // this income level. 24,000 already deducted -> 80,000 balance, over 8 months.
    const flat = [{ upTo: null, rate: 0.1 }];
    const r = computeTdsComputation({
      grossIncome: 1050000,
      deductionLines: [{ code: "STD_DED", name: "Standard Deduction", amount: 50000 }],
      tdsAlreadyDeducted: 24000,
      remainingMonths: 8,
      slabs: flat,
      taxRegime: "OLD",
    });
    expect(r.taxableIncome).toBe(1000000);
    expect(r.taxLiability).toBe(100000);
    expect(r.rebate87A).toBe(0);
    expect(r.cess).toBe(4000);
    expect(r.annualTdsLiability).toBe(104000);
    expect(r.balanceTds).toBe(80000);
    expect(r.monthlyTds).toBe(10000);

    // A revision (higher gross -> higher liability) keeps the same already-deducted figure and only the
    // balance changes — exactly the request's "revised annual - actual already deducted = revised remaining".
    const revised = computeTdsComputation({
      grossIncome: 1350000,
      deductionLines: [{ code: "STD_DED", name: "Standard Deduction", amount: 50000 }],
      tdsAlreadyDeducted: 24000,
      remainingMonths: 8,
      slabs: flat,
      taxRegime: "OLD",
    });
    expect(revised.annualTdsLiability).toBe(135200); // 1,300,000 x 10% x 1.04
    expect(revised.balanceTds).toBe(111200); // 135,200 - 24,000
  });

  it("new regime: income low enough to qualify for the full Section 87A rebate pays no TDS at all", () => {
    const flat = [{ upTo: null, rate: 0.1 }];
    // 600,000 taxable x 10% = 60,000 nominal tax — exactly the new regime's rebate cap — while comfortably
    // under the 12L threshold, so the whole liability is wiped out.
    const r = computeTdsComputation({
      grossIncome: 600000,
      deductionLines: [],
      tdsAlreadyDeducted: 0,
      remainingMonths: 12,
      slabs: flat,
      taxRegime: "NEW",
    });
    expect(r.taxLiability).toBe(60000);
    expect(r.rebate87A).toBe(60000);
    expect(r.cess).toBe(0);
    expect(r.annualTdsLiability).toBe(0);
    expect(r.monthlyTds).toBe(0);
  });

  it("rounds the monthly figure UP so remainingMonths x monthlyTds is never short of the balance", () => {
    // 1,000 over 3 months = 333.33/mo, which x3 falls a paisa short — must round up to 333.34.
    const r = computeTdsComputation({ grossIncome: 0, deductionLines: [], tdsAlreadyDeducted: -1000, remainingMonths: 3, slabs: [{ upTo: null, rate: 0 }], taxRegime: "NEW" });
    expect(r.balanceTds).toBe(1000);
    expect(r.monthlyTds).toBe(333.34);
    expect(r.monthlyTds * 3).toBeGreaterThanOrEqual(1000);
  });

  it("deducts nothing further once TDS already taken exceeds the recalculated liability", () => {
    const r = computeTdsComputation({ grossIncome: 500000, deductionLines: [], tdsAlreadyDeducted: 999999, remainingMonths: 6, slabs, taxRegime: "NEW" });
    expect(r.balanceTds).toBeLessThan(0);
    expect(r.monthlyTds).toBe(0);
  });

  it("deducts nothing when there are no FY months left to spread the balance over", () => {
    // Old regime so the 87A rebate doesn't zero out the liability at this income and mask the point being tested.
    const r = computeTdsComputation({ grossIncome: 1000000, deductionLines: [], tdsAlreadyDeducted: 0, remainingMonths: 0, slabs, taxRegime: "OLD" });
    expect(r.balanceTds).toBeGreaterThan(0);
    expect(r.monthlyTds).toBe(0);
  });
});

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

  it("fails loudly on a malformed StatutoryConfig instead of throwing an unreadable TypeError", () => {
    // A StatutoryConfig hand-edited into a wrong JSON shape (e.g. { slabs: [...] } instead of [...])
    // used to reach here as `slabs.length === undefined` and crash with "slabs is not iterable".
    // @ts-expect-error deliberately wrong shape, same as bad data coming out of the database
    expect(() => calculateSlabTax(500000, { slabs: [] })).toThrow(/malformed/i);
    expect(() => calculateSlabTax(500000, [])).toThrow(/malformed/i);
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
    // Annualized gross 480,000 -> 0 on first 300k, 5% on remaining 180k = 9,000/yr nominal tax, but
    // well under the new regime's Section 87A threshold (12L) so the rebate wipes it out entirely.
    expect(result.employeeDeductions.tds).toBe(0);

    const expectedTotalDeductions =
      1800 + 0 + 200 + 0;
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
