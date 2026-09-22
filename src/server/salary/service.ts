import type { Prisma } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import type { TenantCtx } from "@/server/rbac/context";
import { computeSalaryLines, validateTemplateLines, type SalaryLine, type TemplateLineDef } from "@/lib/salary/compute";

type TemplateWithLines = Prisma.SalaryTemplateGetPayload<{ include: { lines: { include: { component: true } } } }>;

export function toTemplateLines(template: TemplateWithLines): TemplateLineDef[] {
  return template.lines
    .filter((l) => l.component.active)
    .map((l) => ({
      code: l.component.code,
      name: l.component.name,
      isBasic: l.component.isBasic,
      taxable: l.component.taxable,
      includeInPf: l.component.includeInPf,
      includeInEsi: l.component.includeInEsi,
      includeInPt: l.component.includeInPt,
      sortOrder: l.sortOrder,
      calcType: l.calcType,
      value: Number(l.value),
    }));
}

export async function loadTemplates(db: TenantDb, onlyActive = true) {
  return db.salaryTemplate.findMany({
    where: onlyActive ? { active: true } : {},
    orderBy: { name: "asc" },
    include: { lines: { orderBy: { sortOrder: "asc" }, include: { component: true } } },
  });
}

export interface AssignSalaryInput {
  employeeId: string;
  templateId: string;
  ctcAnnual: number;
  effectiveFrom: Date;
  overrides?: Record<string, number>;
  employerPfOptIn: boolean;
  source?: string;
}

/**
 * Gives an employee a salary from a date: the template's rules are worked out for the CTC and the result is
 * SNAPSHOTTED on the employee (so later edits to the template never change what they are paid). The previous
 * salary is closed the day before; nothing is overwritten.
 */
export async function assignSalary(db: TenantDb, ctx: TenantCtx, input: AssignSalaryInput): Promise<{ id: string; grossMonthly: number; lines: SalaryLine[]; warnings: string[] }> {
  if (!(input.ctcAnnual > 0)) throw new Error("CTC must be greater than 0");

  const template = await db.salaryTemplate.findUnique({
    where: { id: input.templateId },
    include: { lines: { orderBy: { sortOrder: "asc" }, include: { component: true } } },
  });
  if (!template) throw new Error("Salary structure not found");
  const lines = toTemplateLines(template);
  const problems = validateTemplateLines(lines);
  if (problems.length) throw new Error(`${template.name}: ${problems.join("; ")}`);

  const employee = await db.employee.findUnique({ where: { id: input.employeeId }, select: { id: true, employeeCode: true } });
  if (!employee) throw new Error("Employee not found");

  const latest = await db.employeeSalary.findFirst({ where: { employeeId: input.employeeId }, orderBy: { effectiveFrom: "desc" } });
  if (latest && input.effectiveFrom <= latest.effectiveFrom) {
    throw new Error(`The effective date must be after the current salary's (${latest.effectiveFrom.toISOString().slice(0, 10)})`);
  }

  const computed = computeSalaryLines(lines, input.ctcAnnual, input.overrides);

  await db.employeeSalary.updateMany({
    where: { employeeId: input.employeeId, effectiveTo: null },
    data: { effectiveTo: new Date(input.effectiveFrom.getTime() - 86_400_000) },
  });
  const created = await db.employeeSalary.create({
    data: {
      companyId: ctx.companyId,
      employeeId: input.employeeId,
      templateId: template.id,
      effectiveFrom: input.effectiveFrom,
      ctcAnnual: input.ctcAnnual,
      lines: computed.lines as unknown as Prisma.InputJsonValue,
      grossMonthly: computed.grossMonthly,
      employerPfOptIn: input.employerPfOptIn,
    },
  });
  await audit(db, ctx, {
    module: "salary",
    action: "salary.revise",
    entityType: "EmployeeSalary",
    entityId: created.id,
    oldValue: latest ? { effectiveFrom: latest.effectiveFrom, ctcAnnual: latest.ctcAnnual, grossMonthly: latest.grossMonthly, lines: latest.lines } : undefined,
    newValue: {
      employeeCode: employee.employeeCode, structure: template.name, effectiveFrom: input.effectiveFrom, ctcAnnual: input.ctcAnnual,
      grossMonthly: computed.grossMonthly, lines: computed.lines.map((l) => ({ [l.code]: l.monthlyAmount })), source: input.source,
    },
  });
  return { id: created.id, grossMonthly: computed.grossMonthly, lines: computed.lines, warnings: computed.warnings };
}

/** The salary lines stored on an EmployeeSalary row. */
export function readLines(json: unknown): SalaryLine[] {
  return Array.isArray(json) ? (json as SalaryLine[]) : [];
}
