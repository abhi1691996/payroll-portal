import type { AttendanceStatus } from "@prisma/client";
import { audit } from "@/server/audit/audit";
import { evaluateEntries, saveAttendanceDays, type DayEntry } from "@/server/attendance/service";
import { daysInMonth, monthLabel } from "@/lib/dates";
import { parseTimeToMinutes } from "@/lib/time";
import { formatDisplayDate, formatIsoDate, parseAttendanceStatus, parseDate } from "../parse";
import { BulkInputError, type BulkImporter, type BulkIssue } from "../types";

interface EmployeeEntries {
  employeeId: string;
  shiftId: string | null;
  employeeCode: string;
  name: string;
  entries: DayEntry[];
}

const DAY_HEADER = /^(?:day)?(\d{1,2})$/;

/**
 * Two layouts, detected from the header row:
 *  - Daily list:    employeeCode, date, then status and/or inTime, outTime   (one row per employee per day)
 *  - Monthly grid:  employeeCode, [name], 1, 2, ... 31                       (one row per employee; the
 *                   month/year come from the selector on the page; cells hold a status code)
 * In the daily list, punch times are turned into a status by the company's shift and attendance rules; an
 * explicit status wins. A row with any bad cell is skipped as a whole so an employee is never half-updated.
 */
export const attendanceImporter: BulkImporter = {
  required: ["employeecode"],
  requiredLabels: ["employeeCode"],
  maxRows: 12000,

  async plan({ headers, records, ctx, db }) {
    const isList = headers.includes("date") && (headers.includes("status") || headers.includes("intime") || headers.includes("outtime"));
    const dayColumns = headers
      .map((h) => ({ header: h, day: Number(h.match(DAY_HEADER)?.[1]) }))
      .filter((c) => c.day >= 1 && c.day <= 31);

    if (!isList && dayColumns.length === 0) {
      throw new BulkInputError(
        "Couldn't recognise the layout. Use columns employeeCode, date and status and/or inTime, outTime — or employeeCode followed by day columns 1…31."
      );
    }

    const year = Number(ctx.params.year);
    const month = Number(ctx.params.month);
    if (!isList && (!year || !month || month < 1 || month > 12)) {
      throw new BulkInputError("Pick the month this grid is for before uploading.");
    }
    const companyId = ctx.actor.companyId;

    const codes = [...new Set(records.map((r) => r.values.employeecode).filter(Boolean))];
    const employees = await db.employee.findMany({
      where: { employeeCode: { in: codes } },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, shiftId: true },
    });
    const byCode = new Map(employees.map((e) => [e.employeeCode, e]));

    const finalized = await db.payrollRun.findMany({ where: { status: "FINALIZED" }, select: { month: true, year: true } });
    const isFinalized = (d: Date) => finalized.some((r) => r.year === d.getUTCFullYear() && r.month === d.getUTCMonth() + 1);

    const issues: BulkIssue[] = [];
    const grouped = new Map<string, EmployeeEntries>();
    const seenKeys = new Map<string, number>();
    const validLines = new Set<number>();
    const badLines = new Set<number>();

    const bad = (line: number, message: string) => {
      badLines.add(line);
      const existing = issues.find((i) => i.line === line);
      if (existing) existing.messages.push(message);
      else issues.push({ line, messages: [message] });
    };

    const addEntry = (line: number, code: string, entry: DayEntry): boolean => {
      const employee = byCode.get(code)!;
      if (isFinalized(entry.date)) {
        bad(line, `Payroll for ${monthLabel(entry.date.getUTCFullYear(), entry.date.getUTCMonth() + 1)} is finalized and can't be changed`);
        return false;
      }
      const key = `${code}|${formatIsoDate(entry.date)}`;
      const first = seenKeys.get(key);
      if (first !== undefined) {
        bad(line, `${code} already has an entry for ${formatDisplayDate(entry.date)} (line ${first})`);
        return false;
      }
      seenKeys.set(key, line);
      let group = grouped.get(code);
      if (!group) {
        group = { employeeId: employee.id, shiftId: employee.shiftId, employeeCode: code, name: `${employee.firstName} ${employee.lastName}`, entries: [] };
        grouped.set(code, group);
      }
      group.entries.push(entry);
      validLines.add(line);
      return true;
    };

    if (isList) {
      for (const { line, values: v } of records) {
        const code = v.employeecode ?? "";
        if (!byCode.has(code)) {
          bad(line, code ? `No employee with code ${code}` : "employeeCode is required");
          continue;
        }
        const date = parseDate(v.date ?? "");
        if (!date) bad(line, "date: use a date like 2025-04-01 or 01/04/2025");

        const statusRaw = v.status ?? "";
        const status = statusRaw ? parseAttendanceStatus(statusRaw) : null;
        if (statusRaw && !status) bad(line, `status: "${statusRaw}" isn't valid — use P, A, HD, HOL, WO, L or WFH (or leave blank to work it out from the times)`);

        const inRaw = v.intime ?? "";
        const outRaw = v.outtime ?? "";
        const inMinutes = inRaw ? parseTimeToMinutes(inRaw) : null;
        const outMinutes = outRaw ? parseTimeToMinutes(outRaw) : null;
        if (inRaw && inMinutes === null) bad(line, `inTime: "${inRaw}" isn't a time — use 09:30, 9:30 AM or 18:30`);
        if (outRaw && outMinutes === null) bad(line, `outTime: "${outRaw}" isn't a time — use 09:30, 9:30 AM or 18:30`);
        if (!statusRaw && !inRaw && !outRaw) bad(line, "Give a status, or in/out times");

        if (date && !badLines.has(line)) addEntry(line, code, { date, inMinutes, outMinutes, statusOverride: status });
      }
    } else {
      const total = daysInMonth(year, month);
      for (const { line, values: v } of records) {
        const code = v.employeecode ?? "";
        if (!byCode.has(code)) {
          bad(line, code ? `No employee with code ${code}` : "employeeCode is required");
          continue;
        }
        // Validate the whole row first so a single bad cell doesn't leave it half-applied.
        const pending: DayEntry[] = [];
        let rowOk = true;
        for (const { header, day } of dayColumns) {
          const cell = v[header] ?? "";
          if (cell === "") continue; // blank = leave that day untouched
          if (day > total) {
            bad(line, `Day ${day} has a value but ${monthLabel(year, month)} only has ${total} days`);
            rowOk = false;
            continue;
          }
          const status = parseAttendanceStatus(cell);
          if (!status) {
            bad(line, `Day ${day}: "${cell}" isn't valid — use P, A, HD, HOL, WO, L or WFH`);
            rowOk = false;
            continue;
          }
          pending.push({ date: new Date(Date.UTC(year, month - 1, day)), inMinutes: null, outMinutes: null, statusOverride: status });
        }
        if (!rowOk) continue;
        if (pending.length === 0) { bad(line, "Row has no attendance values"); continue; }
        if (pending.some((p) => isFinalized(p.date))) { bad(line, `Payroll for ${monthLabel(year, month)} is finalized and can't be changed`); continue; }
        if (seenKeys.has(`${code}|grid`)) { bad(line, `${code} appears more than once (line ${seenKeys.get(`${code}|grid`)})`); continue; }
        seenKeys.set(`${code}|grid`, line);
        for (const p of pending) addEntry(line, code, p);
      }
    }

    const valid = [...validLines].filter((l) => !badLines.has(l)).length;
    issues.sort((a, b) => a.line - b.line);

    // Preview what will actually be recorded, using the company's own shift and attendance rules.
    const previewRows: string[][] = [];
    const warnings: BulkIssue[] = [];
    let totalDays = 0;
    let missingPunch = 0;
    for (const g of grouped.values()) {
      const evaluated = await evaluateEntries(db, companyId, { id: g.employeeId, shiftId: g.shiftId }, g.entries);
      const count = (s: AttendanceStatus) => evaluated.filter((e) => e.status === s).length;
      const late = evaluated.filter((e) => e.result.isLate).length;
      const ot = evaluated.reduce((s, e) => s + e.result.overtimeMinutes, 0);
      missingPunch += evaluated.filter((e) => e.result.flags.includes("MISSING_PUNCH")).length;
      totalDays += evaluated.length;
      const other = evaluated.length - count("PRESENT") - count("ABSENT") - count("HALF_DAY");
      previewRows.push([g.employeeCode, g.name, String(evaluated.length), String(count("PRESENT")), String(count("ABSENT")), String(count("HALF_DAY")), String(other), String(late), ot ? `${(ot / 60).toFixed(1)}h` : "—"]);
    }
    if (missingPunch > 0) warnings.push({ line: 0, messages: [`${missingPunch} day${missingPunch > 1 ? "s have" : " has"} only one punch — recorded per your "missing punch" rule and flagged for review`] });

    return {
      total: records.length,
      valid,
      issues,
      warnings,
      preview: {
        columns: ["Code", "Employee", "Days", "Present", "Absent", "Half day", "Other", "Late", "Overtime"],
        rows: previewRows.slice(0, 10),
        truncated: previewRows.length > 10,
      },
      summary: `${totalDays} day${totalDays === 1 ? "" : "s"} of attendance for ${grouped.size} employee${grouped.size === 1 ? "" : "s"} — existing entries for the same days are replaced`,
      async commit() {
        let total = 0;
        for (const g of grouped.values()) {
          const r = await saveAttendanceDays(db, companyId, { id: g.employeeId, shiftId: g.shiftId }, g.entries);
          total += r.saved;
        }
        await audit(db, ctx.actor, { module: "attendance", action: "attendance.import", newValue: { employees: grouped.size, days: total } });
        return { imported: total };
      },
    };
  },
};
