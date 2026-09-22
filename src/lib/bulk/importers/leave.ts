import type { LeaveRequestStatus } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { setLeaveBalance } from "@/server/leave/service";
import { countLeaveDays } from "@/lib/leave/planner";
import { formatDisplayDate, formatIsoDate, parseDate } from "../parse";
import type { BulkImporter, BulkIssue } from "../types";

const STATUSES: LeaveRequestStatus[] = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];

async function lookups(db: TenantDb, codes: string[]) {
  const [employees, leaveTypes] = await Promise.all([
    db.employee.findMany({
      where: { employeeCode: { in: codes } },
      select: { id: true, employeeCode: true, firstName: true, lastName: true },
    }),
    db.leaveType.findMany(),
  ]);
  return {
    employeeByCode: new Map(employees.map((e) => [e.employeeCode, e])),
    typeByName: new Map(leaveTypes.map((t) => [t.name.toLowerCase(), t])),
    typeNames: leaveTypes.map((t) => t.name),
  };
}

/** Historical or offline-approved leave. Imported rows default to APPROVED. */
export const leaveRequestsImporter: BulkImporter = {
  required: ["employeecode", "leavetype", "startdate", "enddate"],
  requiredLabels: ["employeeCode", "leaveType", "startDate", "endDate"],
  maxRows: 2000,

  async plan({ records, ctx, db }) {
    const codes = [...new Set(records.map((r) => r.values.employeecode).filter(Boolean))];
    const { employeeByCode, typeByName, typeNames } = await lookups(db, codes);
    const { pattern } = await loadRules(db, ctx.actor.companyId);

    const existing = await db.leaveRequest.findMany({
      where: { employeeId: { in: [...employeeByCode.values()].map((e) => e.id) } },
      select: { employeeId: true, leaveTypeId: true, startDate: true, endDate: true },
    });
    const keyOf = (employeeId: string, typeId: string, start: Date, end: Date) =>
      `${employeeId}|${typeId}|${formatIsoDate(start)}|${formatIsoDate(end)}`;
    const seen = new Set(existing.map((e) => keyOf(e.employeeId, e.leaveTypeId, e.startDate, e.endDate)));

    const issues: BulkIssue[] = [];
    const valid: {
      employeeId: string;
      leaveTypeId: string;
      startDate: Date;
      endDate: Date;
      status: LeaveRequestStatus;
      reason: string | null;
      days: number;
      preview: string[];
    }[] = [];
    const holidayCache = new Map<string, Set<string>>();

    for (const { line, values: v } of records) {
      const messages: string[] = [];
      const employee = employeeByCode.get(v.employeecode ?? "");
      if (!employee) messages.push(v.employeecode ? `No employee with code ${v.employeecode}` : "employeeCode is required");

      const type = typeByName.get((v.leavetype ?? "").toLowerCase());
      if (!type) messages.push(`leaveType "${v.leavetype ?? ""}" not found. Available: ${typeNames.join(", ")}`);

      const startDate = parseDate(v.startdate ?? "");
      const endDate = parseDate(v.enddate ?? "");
      if (!startDate) messages.push("startDate: use a date like 2025-04-01 or 01/04/2025");
      if (!endDate) messages.push("endDate: use a date like 2025-04-01 or 01/04/2025");
      if (startDate && endDate && endDate < startDate) messages.push("endDate is before startDate");

      let status: LeaveRequestStatus = "APPROVED";
      if (v.status) {
        const candidate = v.status.toUpperCase() as LeaveRequestStatus;
        if (STATUSES.includes(candidate)) status = candidate;
        else messages.push(`status: use ${STATUSES.join(", ")}`);
      }

      if (messages.length === 0 && employee && type && startDate && endDate) {
        const key = keyOf(employee.id, type.id, startDate, endDate);
        if (seen.has(key)) messages.push("This leave already exists for the employee");
        else seen.add(key);
      }

      if (messages.length > 0 || !employee || !type || !startDate || !endDate) {
        issues.push({ line, messages });
        continue;
      }

      // Days that count = working days in the range (weekly offs and holidays are not leave).
      const key = `${startDate.getTime()}-${endDate.getTime()}`;
      if (!holidayCache.has(key)) holidayCache.set(key, await loadHolidays(db, startDate, endDate));
      const days = countLeaveDays({
        from: startDate, to: endDate, isHalfDay: false, pattern, holidays: holidayCache.get(key)!, countWeeklyOffs: false, countHolidays: false,
      }).days;

      valid.push({
        employeeId: employee.id,
        leaveTypeId: type.id,
        startDate,
        endDate,
        status,
        reason: v.reason || null,
        days,
        preview: [
          `${employee.firstName} ${employee.lastName}`,
          type.name,
          formatDisplayDate(startDate),
          formatDisplayDate(endDate),
          `${days} day${days === 1 ? "" : "s"}`,
          status,
        ],
      });
    }

    const previewRows = valid.slice(0, 8).map((r) => r.preview);
    return {
      total: records.length,
      valid: valid.length,
      issues,
      warnings: [],
      preview: {
        columns: ["Employee", "Type", "From", "To", "Days", "Status"],
        rows: previewRows,
        truncated: valid.length > previewRows.length,
      },
      summary: `${valid.length} historical leave record${valid.length === 1 ? "" : "s"} will be added (they don't change balances — set those with the balances upload)`,
      async commit() {
        const decidedAt = new Date();
        await db.leaveRequest.createMany({
          data: valid.map((r) => ({
            companyId: ctx.actor.companyId,
            employeeId: r.employeeId,
            leaveTypeId: r.leaveTypeId,
            startDate: r.startDate,
            endDate: r.endDate,
            days: r.days,
            status: r.status,
            reason: r.reason,
            ...(r.status === "PENDING" ? {} : { decidedById: ctx.actor.userId, decidedAt }),
          })),
        });
        await audit(db, ctx.actor, {
          module: "leave",
          action: "leave.import",
          newValue: { requests: valid.length },
        });
        return { imported: valid.length };
      },
    };
  },
};

/**
 * Sets each employee's balance for a leave type as of a date. Nothing is overwritten: the difference is added
 * to the ledger as one entry, so the history stays auditable. Accruals up to that date are treated as
 * included in the balance you upload.
 */
export const leaveBalancesImporter: BulkImporter = {
  required: ["employeecode", "leavetype", "balance"],
  requiredLabels: ["employeeCode", "leaveType", "balance"],
  maxRows: 3000,

  async plan({ records, ctx, db }) {
    const codes = [...new Set(records.map((r) => r.values.employeecode).filter(Boolean))];
    const { employeeByCode, typeByName, typeNames } = await lookups(db, codes);

    const sums = await db.leaveLedger.groupBy({
      by: ["employeeId", "leaveTypeId"],
      where: { employeeId: { in: [...employeeByCode.values()].map((e) => e.id) } },
      _sum: { days: true },
    });
    const current = new Map(sums.map((x) => [`${x.employeeId}|${x.leaveTypeId}`, Number(x._sum.days ?? 0)]));

    const issues: BulkIssue[] = [];
    const seen = new Map<string, number>();
    const valid: { employeeId: string; leaveTypeId: string; balance: number; asOf: Date | undefined; before: number; preview: string[] }[] = [];

    for (const { line, values: v } of records) {
      const messages: string[] = [];
      const employee = employeeByCode.get(v.employeecode ?? "");
      if (!employee) messages.push(v.employeecode ? `No employee with code ${v.employeecode}` : "employeeCode is required");

      const type = typeByName.get((v.leavetype ?? "").toLowerCase());
      if (!type) messages.push(`leaveType "${v.leavetype ?? ""}" not found. Available: ${typeNames.join(", ")}`);
      else if (!type.isPaid) messages.push(`${type.name} is unpaid and has no balance`);

      const balance = /^-?\d+(\.\d+)?$/.test(v.balance ?? "") ? Number(v.balance) : NaN;
      if (Number.isNaN(balance)) messages.push("balance: enter a number of days, e.g. 7.5");
      else if (balance < 0) messages.push("balance can't be negative");

      let asOf: Date | undefined;
      if (v.asof) {
        asOf = parseDate(v.asof) ?? undefined;
        if (!asOf) messages.push("asOf: use a date like 2025-04-01 (or leave blank for today)");
      }

      if (messages.length === 0 && employee && type) {
        const key = `${employee.id}|${type.id}`;
        const first = seen.get(key);
        if (first !== undefined) messages.push(`Duplicate of line ${first}`);
        else seen.set(key, line);
      }

      if (messages.length > 0 || !employee || !type) {
        issues.push({ line, messages });
        continue;
      }
      const before = current.get(`${employee.id}|${type.id}`) ?? 0;
      valid.push({
        employeeId: employee.id, leaveTypeId: type.id, balance, asOf, before,
        preview: [`${employee.firstName} ${employee.lastName}`, type.name, String(before), String(balance)],
      });
    }

    const previewRows = valid.slice(0, 8).map((r) => r.preview);
    return {
      total: records.length,
      valid: valid.length,
      issues,
      warnings: [],
      preview: {
        columns: ["Employee", "Leave type", "Balance now", "Balance after"],
        rows: previewRows,
        truncated: valid.length > previewRows.length,
      },
      summary: `${valid.length} balance${valid.length === 1 ? "" : "s"} will be set (each adds one ledger entry for the difference)`,
      async commit() {
        let changed = 0;
        for (const r of valid) {
          const delta = await setLeaveBalance(db, ctx.actor, {
            employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, target: r.balance, asOf: r.asOf, note: "Balance set by bulk upload",
          });
          if (delta !== 0) changed++;
        }
        await audit(db, ctx.actor, {
          module: "leave", action: "leave.balance.import", newValue: { balances: valid.length, changed },
        });
        return { imported: valid.length };
      },
    };
  },
};
