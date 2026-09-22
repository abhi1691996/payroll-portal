import type { AttendanceStatus } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { approvedLeaveMap } from "@/server/leave/days";
import { classifyDay, isoDate, type DayType } from "@/lib/attendance/calendar";
import { evaluateDay, type DayResult } from "@/lib/attendance/engine";
import { toInstant } from "@/lib/time";

export interface DayEntry {
  /** UTC-midnight date. */
  date: Date;
  inMinutes: number | null;
  outMinutes: number | null;
  /** When set, this status wins over the one worked out from the punches. */
  statusOverride: AttendanceStatus | null;
}

export interface EvaluatedDay {
  entry: DayEntry;
  dayType: DayType;
  result: DayResult;
  /** What will be recorded; null = nothing (the day is cleared). */
  status: AttendanceStatus | null;
}

/**
 * Works out what each day would be recorded as, using the employee's shift and the company's rules, without
 * writing anything. Used for previews and by the save below, so both always agree.
 */
export async function evaluateEntries(
  db: TenantDb,
  companyId: string,
  employee: { id: string; shiftId: string | null },
  entries: DayEntry[]
): Promise<EvaluatedDay[]> {
  if (entries.length === 0) return [];
  const times = entries.map((e) => e.date.getTime());
  const from = new Date(Math.min(...times));
  const to = new Date(Math.max(...times));

  const { pattern, rules, shiftFor, setting } = await loadRules(db, companyId);
  const holidays = await loadHolidays(db, from, to);
  const leaves = (await approvedLeaveMap(db, [employee.id], from, to, pattern, holidays, setting.defaultLeavePolicyId)).get(employee.id);
  const shift = shiftFor(employee);

  return entries.map((entry) => {
    const dayType = classifyDay(entry.date, pattern, holidays);
    const result = evaluateDay(
      { dayType, shift, inMinutes: entry.inMinutes, outMinutes: entry.outMinutes, onLeave: !!leaves?.get(isoDate(entry.date)) },
      rules
    );
    const hasPunch = entry.inMinutes !== null || entry.outMinutes !== null;
    let status = entry.statusOverride ?? result.status;
    // A non-working day with nothing entered stays empty rather than being filled in.
    if (!hasPunch && !entry.statusOverride && dayType !== "WORKING") status = null;
    return { entry, dayType, result, status };
  });
}

/**
 * Saves attendance days for one employee. Each day is evaluated against the company's shift and rules:
 * punches -> status, late / early-leave and overtime. A day that comes out with no status is REMOVED
 * (so clearing a row clears the record). Runs inside the caller's tenant transaction.
 */
export async function saveAttendanceDays(
  db: TenantDb,
  companyId: string,
  employee: { id: string; shiftId: string | null },
  entries: DayEntry[]
): Promise<{ saved: number; removed: number }> {
  let saved = 0;
  let removed = 0;
  for (const { entry: e, result, status } of await evaluateEntries(db, companyId, employee, entries)) {
    if (!status) {
      removed += (await db.attendanceRecord.deleteMany({ where: { employeeId: employee.id, date: e.date } })).count;
      continue;
    }
    const outAbs = e.outMinutes !== null && e.inMinutes !== null && e.outMinutes < e.inMinutes ? e.outMinutes + 1440 : e.outMinutes;
    const data = {
      status,
      inAt: e.inMinutes !== null ? toInstant(e.date, e.inMinutes) : null,
      outAt: outAbs !== null ? toInstant(e.date, outAbs) : null,
      workedMinutes: result.workedMinutes,
      lateMinutes: result.lateMinutes,
      earlyLeaveMinutes: result.earlyLeaveMinutes,
      overtimeMinutes: result.overtimeMinutes,
      isLate: result.isLate,
      flags: result.flags.length ? result.flags.join(",") : null,
    };
    await db.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: employee.id, date: e.date } },
      create: { companyId, employeeId: employee.id, date: e.date, ...data },
      update: data,
    });
    saved++;
  }
  return { saved, removed };
}
