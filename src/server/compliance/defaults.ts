/**
 * Starting statutory rates given to every new company (FY2024-25 India defaults). Each company's admin
 * can review and add newer effective-dated versions under Settings. These are defaults, not advice:
 * have your CA verify them before running real payroll.
 */
export const DEFAULT_PROFESSIONAL_TAX_SLABS = [
  { upTo: 15000, amount: 0 },
  { upTo: 25000, amount: 150 },
  { upTo: null, amount: 200 },
];

export const DEFAULT_INCOME_TAX_SLABS = {
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
};

export const DEFAULT_STATUTORY = {
  effectiveFrom: new Date("2024-04-01"),
  pfEmployeeRate: 0.12,
  pfEmployerRate: 0.12,
  pfWageCeiling: 15000,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  esiWageThreshold: 21000,
  professionalTaxSlabs: DEFAULT_PROFESSIONAL_TAX_SLABS,
  incomeTaxSlabs: DEFAULT_INCOME_TAX_SLABS,
};
