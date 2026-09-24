"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { createAndApproveTdsComputation, createTdsComputation, approveTdsComputation, withdrawTdsComputation } from "@/server/tds/service";
import type { TdsDeductionLine } from "@/lib/payroll-calculations";

function revalidate() {
  revalidatePath("/payroll/tds");
}

function readComputationInput(formData: FormData) {
  const employeeId = String(formData.get("employeeId") ?? "");
  const financialYear = Number(formData.get("financialYear"));
  const taxRegime = formData.get("taxRegime") === "OLD" ? "OLD" : "NEW";
  const grossIncome = Number(formData.get("grossIncome"));
  const revisionReason = String(formData.get("revisionReason") ?? "").trim() || null;
  let deductionLines: TdsDeductionLine[] = [];
  try {
    deductionLines = JSON.parse(String(formData.get("deductionLines") ?? "[]"));
  } catch {
    throw new Error("Deduction lines are malformed");
  }
  if (!employeeId) throw new Error("Choose an employee");
  if (!Number.isInteger(financialYear)) throw new Error("Choose a financial year");
  if (!Number.isFinite(grossIncome)) throw new Error("Gross income must be a number");
  return { employeeId, financialYear, taxRegime, grossIncome, deductionLines, revisionReason } as const;
}

export async function saveTdsDraftAction(formData: FormData) {
  const ctx = await assertPermission("tds.manage", "COMPANY");
  const input = readComputationInput(formData);
  await withTenant(ctx.companyId, (db) => createTdsComputation(db, ctx, input));
  revalidate();
}

export async function saveAndApproveTdsAction(formData: FormData) {
  const ctx = await assertPermission("tds.manage", "COMPANY");
  const input = readComputationInput(formData);
  await withTenant(ctx.companyId, (db) => createAndApproveTdsComputation(db, ctx, input));
  revalidate();
}

export async function approveTdsAction(computationId: string) {
  const ctx = await assertPermission("tds.manage", "COMPANY");
  await withTenant(ctx.companyId, (db) => approveTdsComputation(db, ctx, computationId));
  revalidate();
}

export async function withdrawTdsAction(computationId: string) {
  const ctx = await assertPermission("tds.manage", "COMPANY");
  await withTenant(ctx.companyId, (db) => withdrawTdsComputation(db, ctx, computationId));
  revalidate();
}
