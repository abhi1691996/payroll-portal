import { audit } from "@/server/audit/audit";
import { assignSalary, loadTemplates, toTemplateLines } from "@/server/salary/service";
import { computeSalaryLines, validateTemplateLines, type TemplateLineDef } from "@/lib/salary/compute";
import { normalizeHeader } from "../../csv";
import { formatDisplayDate, parseAmount, parseBool, parseDate } from "../parse";
import type { BulkImporter, BulkIssue } from "../types";

interface ValidSalary {
  line: number;
  employeeId: string;
  employeeCode: string;
  name: string;
  effectiveFrom: Date;
  ctcAnnual: number;
  templateId: string;
  templateName: string;
  overrides: Record<string, number>;
  employerPfOptIn: boolean;
  taxRegime: "OLD" | "NEW" | null;
  grossMonthly: number;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/**
 * Salary upload against the COMPANY'S OWN structures. Columns: employeeCode, effectiveFrom, ctcAnnual, and
 * optionally `structure` (a structure name), employerPfOptIn, taxRegime, plus one column per component code
 * (e.g. BASIC, HRA, CAR_ALLOWANCE) to set an exact monthly amount instead of the structure's rule.
 */
export const salaryImporter: BulkImporter = {
  required: ["employeecode", "effectivefrom", "ctcannual"],
  requiredLabels: ["employeeCode", "effectiveFrom", "ctcAnnual"],
  maxRows: 1000,

  async plan({ records, headers, ctx, db }) {
    const issues: BulkIssue[] = [];
    const warnings: BulkIssue[] = [];

    const templates = await loadTemplates(db);
    const templateByName = new Map(templates.map((t) => [t.name.trim().toLowerCase(), t]));
    const components = await db.salaryComponent.findMany({ where: { active: true } });
    // Component columns are matched on the normalised code: "CAR_ALLOWANCE" <-> "carallowance".
    const componentColumns = components.filter((c) => headers.includes(normalizeHeader(c.code)));

    const codes = [...new Set(records.map((r) => r.values.employeecode).filter(Boolean))];
    const employees = await db.employee.findMany({
      where: { employeeCode: { in: codes } },
      select: {
        id: true, employeeCode: true, firstName: true, lastName: true, taxRegime: true,
        salaries: { orderBy: { effectiveFrom: "desc" }, take: 1, select: { effectiveFrom: true, templateId: true } },
      },
    });
    const byCode = new Map(employees.map((e) => [e.employeeCode, e]));
    const templateLines = new Map(templates.map((t) => [t.id, toTemplateLines(t)]));

    // Pass 1: field-level validation.
    const candidates: ValidSalary[] = [];
    for (const { line, values: v } of records) {
      const messages: string[] = [];
      const code = v.employeecode ?? "";
      const employee = byCode.get(code);
      if (!code) messages.push("employeeCode is required");
      else if (!employee) messages.push(`No employee with code ${code} — import employees first`);

      const effectiveFrom = parseDate(v.effectivefrom ?? "");
      if (!effectiveFrom) messages.push("effectiveFrom: use a date like 2025-04-01 or 01/04/2025");

      const ctc = parseAmount(v.ctcannual ?? "");
      if (ctc === null || ctc <= 0) messages.push("ctcAnnual: enter a plain number greater than 0, e.g. 600000");

      // Which structure? Named in the sheet, else the employee's current one, else the only one there is.
      let template = v.structure ? templateByName.get(v.structure.trim().toLowerCase()) : undefined;
      if (v.structure && !template) {
        messages.push(`structure "${v.structure}" not found. Available: ${templates.map((t) => t.name).join(", ") || "none"}`);
      }
      if (!v.structure) {
        template = templates.find((t) => t.id === employee?.salaries[0]?.templateId) ?? (templates.length === 1 ? templates[0] : undefined);
        if (!template) {
          messages.push(`structure is required. Available: ${templates.map((t) => t.name).join(", ") || "none — create one in Settings → Salary Rules"}`);
        }
      }

      const overrides: Record<string, number> = {};
      for (const c of componentColumns) {
        const raw = v[normalizeHeader(c.code)] ?? "";
        if (raw === "") continue;
        const n = parseAmount(raw);
        if (n === null) messages.push(`${c.code}: enter a plain number`);
        else overrides[c.code] = n;
      }

      let employerPfOptIn = true;
      if (v.employerpfoptin) {
        const flag = parseBool(v.employerpfoptin);
        if (flag === null) messages.push("employerPfOptIn: use YES or NO");
        else employerPfOptIn = flag;
      }
      let taxRegime: "OLD" | "NEW" | null = null;
      if (v.taxregime) {
        const regime = v.taxregime.toUpperCase();
        if (regime === "OLD" || regime === "NEW") taxRegime = regime;
        else messages.push("taxRegime: use NEW or OLD");
      }

      let lines: TemplateLineDef[] = [];
      if (template) {
        lines = templateLines.get(template.id)!;
        const problems = validateTemplateLines(lines);
        if (problems.length) messages.push(`${template.name}: ${problems.join("; ")}`);
      }

      if (messages.length > 0 || !employee || !effectiveFrom || !template || ctc === null) {
        issues.push({ line, messages });
        continue;
      }

      const computed = computeSalaryLines(lines, ctc, overrides);
      for (const w of computed.warnings) warnings.push({ line, messages: [w] });

      candidates.push({
        line, employeeId: employee.id, employeeCode: code, name: `${employee.firstName} ${employee.lastName}`,
        effectiveFrom, ctcAnnual: ctc, templateId: template.id, templateName: template.name, overrides,
        employerPfOptIn, taxRegime, grossMonthly: computed.grossMonthly,
      });
    }

    // Pass 2: versioning rules. Each employee's salaries must form a strictly increasing timeline that starts
    // after their current one, so history is never rewritten.
    candidates.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode) || a.effectiveFrom.getTime() - b.effectiveFrom.getTime() || a.line - b.line);
    const latest = new Map<string, Date>();
    for (const e of employees) if (e.salaries[0]) latest.set(e.id, e.salaries[0].effectiveFrom);

    const valid: ValidSalary[] = [];
    for (const row of candidates) {
      const last = latest.get(row.employeeId);
      if (last && row.effectiveFrom.getTime() <= last.getTime()) {
        issues.push({
          line: row.line,
          messages: [`effectiveFrom ${formatDisplayDate(row.effectiveFrom)} must be after ${row.employeeCode}'s latest salary (${formatDisplayDate(last)})`],
        });
        continue;
      }
      latest.set(row.employeeId, row.effectiveFrom);
      valid.push(row);
    }

    issues.sort((a, b) => a.line - b.line);
    warnings.sort((a, b) => a.line - b.line);
    valid.sort((a, b) => a.line - b.line);

    const previewRows = valid.slice(0, 8).map((s) => [
      s.employeeCode, s.name, formatDisplayDate(s.effectiveFrom), s.templateName, inr(s.ctcAnnual), inr(s.grossMonthly),
      s.taxRegime ?? byCode.get(s.employeeCode)?.taxRegime ?? "NEW",
    ]);

    return {
      total: records.length,
      valid: valid.length,
      issues,
      warnings,
      preview: {
        columns: ["Code", "Employee", "Effective from", "Structure", "CTC / yr", "Gross / month", "Regime"],
        rows: previewRows,
        truncated: valid.length > previewRows.length,
      },
      summary: `${valid.length} new salar${valid.length === 1 ? "y" : "ies"} — each closes the employee's previous one the day before`,
      async commit() {
        const ordered = [...valid].sort((a, b) => a.employeeCode.localeCompare(b.employeeCode) || a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
        // Runs inside the caller's tenant transaction: all rows apply, or none do.
        for (const s of ordered) {
          await assignSalary(db, ctx.actor, {
            employeeId: s.employeeId, templateId: s.templateId, ctcAnnual: s.ctcAnnual, effectiveFrom: s.effectiveFrom,
            overrides: s.overrides, employerPfOptIn: s.employerPfOptIn, source: "bulk-import",
          });
          // The regime is the employee's choice, so it lives on the employee.
          const current = byCode.get(s.employeeCode)!;
          if (s.taxRegime && current.taxRegime !== s.taxRegime) {
            await db.employee.update({ where: { id: s.employeeId }, data: { taxRegime: s.taxRegime } });
            await audit(db, ctx.actor, {
              module: "employees", action: "employee.tax_regime.change", entityType: "Employee", entityId: s.employeeId,
              oldValue: { taxRegime: current.taxRegime }, newValue: { employeeCode: s.employeeCode, taxRegime: s.taxRegime, source: "bulk-import" },
            });
            current.taxRegime = s.taxRegime;
          }
        }
        return { imported: ordered.length };
      },
    };
  },
};
