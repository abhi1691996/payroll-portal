import { describe, expect, it } from "vitest";
import { incomeTaxSlabsSchema, professionalTaxSlabsSchema } from "./statutory";

const VALID = {
  OLD: [{ upTo: 250000, rate: 0 }, { upTo: 500000, rate: 0.05 }, { upTo: 1000000, rate: 0.2 }, { upTo: null, rate: 0.3 }],
  NEW: [{ upTo: 300000, rate: 0 }, { upTo: 600000, rate: 0.05 }, { upTo: null, rate: 0.3 }],
};

describe("incomeTaxSlabsSchema", () => {
  it("accepts the shape payroll actually reads", () => {
    expect(incomeTaxSlabsSchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects the shape that broke production: a nested { slabs, standardDeduction } object instead of a flat array", () => {
    const malformed = {
      OLD: VALID.OLD,
      NEW: { slabs: VALID.NEW, standardDeduction: { salary: 75000, pension: 75000 } },
    };
    const result = incomeTaxSlabsSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it("rejects a rate given as a percentage instead of a fraction", () => {
    const result = incomeTaxSlabsSchema.safeParse({ ...VALID, NEW: [{ upTo: null, rate: 30 }] });
    expect(result.success).toBe(false);
  });

  it("rejects upTo bounds that aren't strictly ascending, and a null upTo before the last slab", () => {
    expect(incomeTaxSlabsSchema.safeParse({ ...VALID, NEW: [{ upTo: 500000, rate: 0 }, { upTo: 300000, rate: 0.1 }] }).success).toBe(false);
    expect(incomeTaxSlabsSchema.safeParse({ ...VALID, NEW: [{ upTo: null, rate: 0 }, { upTo: 500000, rate: 0.1 }] }).success).toBe(false);
  });
});

describe("professionalTaxSlabsSchema", () => {
  it("accepts a normal slab table", () => {
    expect(professionalTaxSlabsSchema.safeParse([{ upTo: 15000, amount: 0 }, { upTo: null, amount: 200 }]).success).toBe(true);
  });

  it("rejects an empty table", () => {
    expect(professionalTaxSlabsSchema.safeParse([]).success).toBe(false);
  });
});
