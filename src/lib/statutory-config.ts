import type { TenantDb } from "@/server/tenancy/db";
import type { StatutoryConfigInput } from "@/lib/payroll-calculations";

/**
 * Returns the platform-owned StatutoryConfig effective on the given date (the most recent config
 * whose effectiveFrom is on or before it), mapped to the calculation engine's plain-number input
 * shape (Prisma returns Decimal/JsonValue types). Rates are shared by all companies and maintained
 * by the platform administrator.
 */
export async function getStatutoryConfigFor(db: TenantDb, date: Date): Promise<StatutoryConfigInput> {
  const config = await db.statutoryConfig.findFirst({
    where: { effectiveFrom: { lte: date } },
    orderBy: { effectiveFrom: "desc" },
  });

  if (!config) {
    throw new Error(
      "No statutory rates are configured for this date. Ask your platform administrator to add them."
    );
  }

  return {
    pfEmployeeRate: Number(config.pfEmployeeRate),
    pfEmployerRate: Number(config.pfEmployerRate),
    pfWageCeiling: Number(config.pfWageCeiling),
    esiEmployeeRate: Number(config.esiEmployeeRate),
    esiEmployerRate: Number(config.esiEmployerRate),
    esiWageThreshold: Number(config.esiWageThreshold),
    professionalTaxSlabs: config.professionalTaxSlabs as unknown as StatutoryConfigInput["professionalTaxSlabs"],
    incomeTaxSlabs: config.incomeTaxSlabs as unknown as StatutoryConfigInput["incomeTaxSlabs"],
  };
}
