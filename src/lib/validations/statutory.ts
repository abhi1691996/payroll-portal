import { z } from "zod";

/**
 * The shapes `src/lib/payroll-calculations.ts` actually reads (`TaxSlab[]` / `ProfessionalTaxSlab[]`,
 * per regime). A payroll run throws deep inside slab-tax math if these don't match — badly, since by
 * then it's too late to tell the admin which field was wrong. Validate at save time instead, where a
 * clear message can point at the exact problem.
 */
const taxSlab = z.object({
  upTo: z.number().positive().nullable(),
  rate: z.number().min(0).max(1, "rate is a fraction (0.05 means 5%), not a percentage"),
});

const professionalTaxSlab = z.object({
  upTo: z.number().positive().nullable(),
  amount: z.number().min(0),
});

function ascendingUpTo(slabs: { upTo: number | null }[], ctx: z.RefinementCtx) {
  for (let i = 0; i < slabs.length - 1; i++) {
    if (slabs[i].upTo === null) {
      ctx.addIssue({ code: "custom", message: `Only the last slab can have upTo: null (slab ${i + 1} isn't last)` });
    } else if (slabs[i + 1].upTo !== null && slabs[i + 1].upTo! <= slabs[i].upTo!) {
      ctx.addIssue({ code: "custom", message: `Slab ${i + 2}'s upTo must be greater than slab ${i + 1}'s` });
    }
  }
}

// .strict(): only OLD/NEW slab arrays are used — e.g. a pasted "standardDeduction" key (not a
// configurable field here yet) is rejected instead of silently ignored.
export const incomeTaxSlabsSchema = z
  .object({
    OLD: z.array(taxSlab).min(1, "The old regime needs at least one slab").superRefine(ascendingUpTo),
    NEW: z.array(taxSlab).min(1, "The new regime needs at least one slab").superRefine(ascendingUpTo),
  })
  .strict();

export const professionalTaxSlabsSchema = z.array(professionalTaxSlab).min(1, "Add at least one Professional Tax slab").superRefine(ascendingUpTo);
