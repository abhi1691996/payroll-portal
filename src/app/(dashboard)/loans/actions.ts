"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, getContext } from "@/server/rbac/guard";
import { can, type TenantCtx } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { applyForLoan, decideLoan, withdrawLoan } from "@/server/loans/service";

function revalidate() {
  revalidatePath("/loans");
  revalidatePath("/dashboard");
}

/** The employee applies for their own loan/advance, or HR/an admin records one on their behalf. */
export async function applyLoanAction(formData: FormData) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) throw new Error("Not signed in");
  const tenantCtx = ctx as TenantCtx;
  const employeeId = String(formData.get("employeeId") ?? "");
  if (!employeeId) throw new Error("Choose an employee");
  const isSelf = tenantCtx.employeeId === employeeId;
  if (!((isSelf && can(tenantCtx, "loan.request", "OWN")) || can(tenantCtx, "loan.manage", "COMPANY"))) {
    throw new Error("You can't apply for a loan on behalf of this employee");
  }

  const type = formData.get("type") === "ADVANCE" ? "ADVANCE" : "LOAN";
  const principalAmount = Number(formData.get("principalAmount"));
  const tenureMonths = Number(formData.get("tenureMonths"));
  const reason = String(formData.get("reason") ?? "").trim() || null;

  await withTenant(ctx.companyId, (db) => applyForLoan(db, tenantCtx, { employeeId, type, principalAmount, tenureMonths, reason }));
  revalidate();
}

export async function decideLoanAction(loanId: string, formData: FormData) {
  const ctx = await assertPermission("loan.manage", "COMPANY");
  const action = formData.get("decision") === "REJECT" ? "REJECT" : "APPROVE";
  const comment = String(formData.get("comment") ?? "").trim();

  await withTenant(ctx.companyId, (db) => decideLoan(db, ctx, { loanId, action, comment }));
  revalidate();
}

export async function withdrawLoanAction(loanId: string) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) throw new Error("Not signed in");

  await withTenant(ctx.companyId, (db) => withdrawLoan(db, ctx as TenantCtx, loanId));
  revalidate();
}
