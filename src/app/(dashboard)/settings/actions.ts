"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { incomeTaxSlabsSchema, professionalTaxSlabsSchema } from "@/lib/validations/statutory";

/** Updates the signed-in user's own company. Statutory rates are platform-owned (see /platform). */
export async function saveCompany(formData: FormData) {
  const ctx = await assertPermission("settings.write", "COMPANY");

  const data = {
    name: String(formData.get("name") ?? "").trim(),
    address: String(formData.get("address") ?? "").trim(),
    state: String(formData.get("state") ?? "").trim(),
    pan: (formData.get("pan") as string) || null,
    tan: (formData.get("tan") as string) || null,
    pfEstablishmentId: (formData.get("pfEstablishmentId") as string) || null,
    esiEstablishmentId: (formData.get("esiEstablishmentId") as string) || null,
    payCycleStartDay: Number(formData.get("payCycleStartDay") ?? 1),
  };
  if (!data.name || !data.address || !data.state) throw new Error("Name, address and state are required");
  if (!Number.isInteger(data.payCycleStartDay) || data.payCycleStartDay < 1 || data.payCycleStartDay > 28) {
    throw new Error("Pay cycle start day must be between 1 and 28");
  }

  await withTenant(ctx.companyId, async (db) => {
    // The tenant client can only ever see (and therefore update) the caller's own company row.
    const before = await db.company.findFirst();
    if (!before) throw new Error("Company not found");
    const after = await db.company.update({ where: { id: ctx.companyId }, data });
    await audit(db, ctx, {
      module: "settings",
      action: "company.update",
      entityType: "Company",
      entityId: ctx.companyId,
      oldValue: before,
      newValue: after,
    });
  });

  revalidatePath("/settings");
}

function parseJson(raw: FormDataEntryValue | null, label: string) {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

/**
 * Parses and validates against the exact shape payroll reads (`src/lib/payroll-calculations.ts`).
 * Without this, a pasted slab table in a slightly different shape saves fine here and only blows up
 * — deep inside slab-tax math, as an unreadable exception — the next time someone runs payroll.
 */
function parseSlabs<T>(raw: FormDataEntryValue | null, label: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: { message: string }[] } } }): T {
  const parsed = parseJson(raw, label);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${label}: ${result.error!.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data!;
}

/**
 * Adds a new effective-dated version of this company's statutory rates. Older versions are kept so
 * payroll for earlier months stays accurate.
 */
export async function addStatutoryConfig(formData: FormData) {
  const ctx = await assertPermission("settings.write", "COMPANY");

  const effectiveFrom = new Date(String(formData.get("effectiveFrom")));
  if (Number.isNaN(effectiveFrom.getTime())) throw new Error("Choose an effective date");
  const professionalTaxSlabs = parseSlabs(formData.get("professionalTaxSlabs"), "Professional Tax slabs", professionalTaxSlabsSchema);
  const incomeTaxSlabs = parseSlabs(formData.get("incomeTaxSlabs"), "Income tax slabs", incomeTaxSlabsSchema);

  const rates = {
    pfEmployeeRate: Number(formData.get("pfEmployeeRate")),
    pfEmployerRate: Number(formData.get("pfEmployerRate")),
    pfWageCeiling: Number(formData.get("pfWageCeiling")),
    esiEmployeeRate: Number(formData.get("esiEmployeeRate")),
    esiEmployerRate: Number(formData.get("esiEmployerRate")),
    esiWageThreshold: Number(formData.get("esiWageThreshold")),
  };
  for (const [key, value] of Object.entries(rates)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a non-negative number`);
  }
  for (const key of ["pfEmployeeRate", "pfEmployerRate", "esiEmployeeRate", "esiEmployerRate"] as const) {
    if (rates[key] > 1) throw new Error(`${key} is a fraction (0.12 means 12%), not a percentage`);
  }

  await withTenant(ctx.companyId, async (db) => {
    const created = await db.statutoryConfig.create({
      data: { companyId: ctx.companyId, effectiveFrom, ...rates, professionalTaxSlabs, incomeTaxSlabs },
    });
    await audit(db, ctx, {
      module: "settings",
      action: "statutory.add",
      entityType: "StatutoryConfig",
      entityId: created.id,
      newValue: created,
    });
  });

  revalidatePath("/settings");
}
