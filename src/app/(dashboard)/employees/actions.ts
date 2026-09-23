"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission, getContext } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { createEmployeeWithLogin, nextEmployeeCode } from "@/server/employees/service";
import { assignSalary } from "@/server/salary/service";
import { loadRules } from "@/server/rules/load";
import { findTakenEmails } from "@/server/users/email-registry";
import { hashPassword } from "@/lib/password";
import {
  employeeProfileSchema,
  employeeSchema,
} from "@/lib/validations/employee";

export async function createEmployee(formData: FormData) {
  const ctx = await assertPermission("employee.create", "COMPANY");

  const parsed = employeeSchema.safeParse({
    employeeCode: String(formData.get("employeeCode") || "").trim() || "__AUTO__",
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName"),
    email: formData.get("email"),
    personalEmail: formData.get("personalEmail") ?? "",
    phone: formData.get("phone") ?? "",
    panNumber: (formData.get("panNumber") as string)?.toUpperCase() ?? "",
    aadhaarLast4: formData.get("aadhaarLast4") ?? "",
    bankAccountNumber: formData.get("bankAccountNumber") ?? "",
    bankIfsc: (formData.get("bankIfsc") as string)?.toUpperCase() ?? "",
    department: formData.get("department") ?? "",
    designation: formData.get("designation") ?? "",
    dateOfJoining: formData.get("dateOfJoining"),
    state: formData.get("state"),
    taxRegime: formData.get("taxRegime") || "NEW",
    category: formData.get("category") || "WHITE_COLLAR",
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join(", "));
  }

  const tempPassword = formData.get("tempPassword");
  if (typeof tempPassword !== "string" || tempPassword.length < 8) {
    throw new Error("A temporary password of at least 8 characters is required");
  }

  const data = parsed.data;

  // Login emails are unique across the platform (not just this company).
  if ((await findTakenEmails([data.email])).size > 0) {
    throw new Error("That login email is already registered");
  }

  const passwordHash = await hashPassword(tempPassword);

  await withTenant(ctx.companyId, async (db) => {
    const { setting } = await loadRules(db, ctx.companyId);
    const employeeCode = data.employeeCode === "__AUTO__" ? await nextEmployeeCode(db, setting.employeeCodePrefix) : data.employeeCode;
    if (data.employeeCode === "__AUTO__" && !setting.autoGenerateEmployeeCode) throw new Error("Employee code is required");
    if (await db.employee.findFirst({ where: { employeeCode }, select: { id: true } })) {
      throw new Error(`Employee code ${employeeCode} already exists`);
    }
    await createEmployeeWithLogin(db, ctx, {
      ...data,
      employeeCode,
      dateOfJoining: new Date(data.dateOfJoining),
      passwordHash,
    });
  });

  revalidatePath("/employees");
  redirect("/employees");
}

/**
 * Gives an employee a salary from a date: choose one of the company's salary structures and a CTC. Any
 * component whose amount was typed over is sent as `ov_<CODE>` and replaces the structure's rule for it.
 */
export async function assignEmployeeSalary(employeeId: string, formData: FormData) {
  const ctx = await assertPermission("employee.salary.write", "COMPANY");

  const templateId = String(formData.get("templateId") ?? "");
  const ctcAnnual = Number(formData.get("ctcAnnual"));
  const effectiveFrom = new Date(String(formData.get("effectiveFrom")));
  if (!templateId) throw new Error("Choose a salary structure");
  if (!(ctcAnnual > 0)) throw new Error("CTC must be greater than 0");
  if (Number.isNaN(effectiveFrom.getTime())) throw new Error("Effective date is required");

  const overrides: Record<string, number> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("ov_") && String(value) !== "") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid amount for ${key.slice(3)}`);
      overrides[key.slice(3)] = n;
    }
  }

  await withTenant(ctx.companyId, (db) =>
    assignSalary(db, ctx, {
      employeeId, templateId, ctcAnnual, effectiveFrom, overrides,
      employerPfOptIn: formData.get("employerPfOptIn") === "on",
    })
  );

  revalidatePath(`/employees/${employeeId}`);
  revalidatePath("/employees/salary");
}

/** Shift, leave policy and reporting manager for one employee. Blank shift / policy = the company default. */
export async function updateWorkSettings(employeeId: string, formData: FormData) {
  const ctx = await assertPermission("employee.update", "COMPANY");
  const val = (k: string) => (String(formData.get(k) ?? "") || null);
  const shiftId = val("shiftId");
  const leavePolicyId = val("leavePolicyId");
  const managerId = val("managerId");

  await withTenant(ctx.companyId, async (db) => {
    const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { id: true, employeeCode: true, shiftId: true, leavePolicyId: true, managerId: true } });
    if (!employee) throw new Error("Employee not found");
    if (managerId === employeeId) throw new Error("An employee can't be their own manager");
    if (managerId && !(await db.employee.findUnique({ where: { id: managerId }, select: { id: true } }))) throw new Error("Manager not found");
    // Walk up the chain so two people can never end up managing each other.
    for (let cursor = managerId, hops = 0; cursor && hops < 50; hops++) {
      const up = await db.employee.findUnique({ where: { id: cursor }, select: { managerId: true } });
      if (up?.managerId === employeeId) throw new Error("That would make a reporting loop");
      cursor = up?.managerId ?? null;
    }

    await db.employee.update({ where: { id: employeeId }, data: { shiftId, leavePolicyId, managerId } });
    await audit(db, ctx, {
      module: "employees", action: "employee.work_settings.change", entityType: "Employee", entityId: employeeId,
      oldValue: { shiftId: employee.shiftId, leavePolicyId: employee.leavePolicyId, managerId: employee.managerId },
      newValue: { employeeCode: employee.employeeCode, shiftId, leavePolicyId, managerId },
    });
  });

  revalidatePath(`/employees/${employeeId}`);
}

/**
 * Edits an existing employee's profile — name, category, contact, department/designation, state, PAN,
 * bank details, date of joining. The login email and employee code stay fixed (changing either has
 * knock-on effects elsewhere — logins, bulk-upload matching, payslip history — that this form doesn't
 * try to handle).
 */
export async function updateEmployeeProfile(employeeId: string, formData: FormData) {
  const ctx = await assertPermission("employee.update", "COMPANY");

  const parsed = employeeProfileSchema.safeParse({
    firstName: formData.get("firstName"),
    lastName: formData.get("lastName") ?? "",
    personalEmail: formData.get("personalEmail") ?? "",
    phone: formData.get("phone") ?? "",
    panNumber: (formData.get("panNumber") as string)?.toUpperCase() ?? "",
    aadhaarLast4: formData.get("aadhaarLast4") ?? "",
    bankAccountNumber: formData.get("bankAccountNumber") ?? "",
    bankIfsc: (formData.get("bankIfsc") as string)?.toUpperCase() ?? "",
    department: formData.get("department") ?? "",
    designation: formData.get("designation") ?? "",
    dateOfJoining: formData.get("dateOfJoining"),
    state: formData.get("state"),
    taxRegime: formData.get("taxRegime") || "NEW",
    category: formData.get("category") || "WHITE_COLLAR",
  });
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join(", "));
  const d = parsed.data;

  await withTenant(ctx.companyId, async (db) => {
    const before = await db.employee.findUnique({ where: { id: employeeId } });
    if (!before) throw new Error("Employee not found");

    const after = await db.employee.update({
      where: { id: employeeId },
      data: {
        firstName: d.firstName,
        lastName: d.lastName ?? "",
        category: d.category,
        personalEmail: d.personalEmail || null,
        phone: d.phone || null,
        panNumber: d.panNumber || null,
        aadhaarLast4: d.aadhaarLast4 || null,
        bankAccountNumber: d.bankAccountNumber || null,
        bankIfsc: d.bankIfsc || null,
        department: d.department || null,
        designation: d.designation || null,
        dateOfJoining: new Date(d.dateOfJoining),
        state: d.state,
      },
    });
    // Keep the login's display name in step, if this employee has a portal login.
    if (before.userId) {
      await db.user.update({ where: { id: before.userId }, data: { name: `${d.firstName} ${d.lastName ?? ""}`.trim() } });
    }
    await audit(db, ctx, {
      module: "employees",
      action: "employee.profile.update",
      entityType: "Employee",
      entityId: employeeId,
      oldValue: { firstName: before.firstName, lastName: before.lastName, category: before.category, department: before.department, designation: before.designation, state: before.state },
      newValue: { employeeCode: after.employeeCode, firstName: after.firstName, lastName: after.lastName, category: after.category, department: after.department, designation: after.designation, state: after.state },
    });
  });

  revalidatePath(`/employees/${employeeId}`);
  revalidatePath("/employees");
}

/**
 * Records which income-tax regime an employee has opted for. Payroll uses it for TDS from the next
 * run onwards; already-finalized payslips keep the regime they were calculated with.
 */
export async function updateTaxRegime(employeeId: string, formData: FormData) {
  // Either HR (employee.update) or payroll (salary.write) may record the employee's declaration.
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) throw new Error("Not signed in");
  if (!can(ctx, "employee.update", "COMPANY") && !can(ctx, "employee.salary.write", "COMPANY")) {
    throw new Error("You don't have permission to change an employee's tax regime");
  }
  const companyId = ctx.companyId;

  const regime = formData.get("taxRegime");
  if (regime !== "OLD" && regime !== "NEW") throw new Error("Choose the old or the new tax regime");

  await withTenant(companyId, async (db) => {
    const employee = await db.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, employeeCode: true, taxRegime: true },
    });
    if (!employee) throw new Error("Employee not found");
    if (employee.taxRegime === regime) return;

    await db.employee.update({ where: { id: employeeId }, data: { taxRegime: regime } });
    await audit(db, { ...ctx, companyId }, {
      module: "employees",
      action: "employee.tax_regime.change",
      entityType: "Employee",
      entityId: employeeId,
      oldValue: { taxRegime: employee.taxRegime },
      newValue: { employeeCode: employee.employeeCode, taxRegime: regime },
    });
  });

  revalidatePath(`/employees/${employeeId}`);
  revalidatePath("/employees");
  revalidatePath("/employees/salary");
}
