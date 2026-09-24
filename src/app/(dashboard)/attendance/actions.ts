"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { employeeScopeWhere } from "@/server/rbac/context";
import { saveAttendanceDays, type DayEntry } from "@/server/attendance/service";
import { daysInMonth } from "@/lib/dates";
import { parseTimeToMinutes } from "@/lib/time";
import type { AttendanceStatus } from "@prisma/client";

const VALID_STATUSES: AttendanceStatus[] = ["PRESENT", "ABSENT", "HALF_DAY", "HOLIDAY", "WEEK_OFF", "ON_LEAVE", "WFH"];

/**
 * Saves one employee's month. For each day: an in time, an out time and a status. "Auto" (or blank) means the
 * status is worked out from the times by the company's shift and attendance rules; picking a status overrides
 * it. A working day with no times and Auto is cleared.
 */
export async function saveAttendance(employeeId: string, year: number, month: number, formData: FormData) {
  // TEAM scope lets a manager mark their own reports; COMPANY scope lets HR mark anyone.
  const ctx = await assertPermission("attendance.write", "TEAM");

  const total = daysInMonth(year, month);
  const entries: DayEntry[] = [];
  for (let day = 1; day <= total; day++) {
    const inRaw = String(formData.get(`in-${day}`) ?? "");
    const outRaw = String(formData.get(`out-${day}`) ?? "");
    const inMinutes = inRaw ? parseTimeToMinutes(inRaw) : null;
    const outMinutes = outRaw ? parseTimeToMinutes(outRaw) : null;
    if ((inRaw && inMinutes === null) || (outRaw && outMinutes === null)) throw new Error(`Day ${day}: enter the time like 09:30`);

    const chosen = String(formData.get(`status-${day}`) ?? "AUTO");
    const statusOverride = VALID_STATUSES.includes(chosen as AttendanceStatus) ? (chosen as AttendanceStatus) : null;
    entries.push({ date: new Date(Date.UTC(year, month - 1, day)), inMinutes, outMinutes, statusOverride });
  }

  await withTenant(ctx.companyId, async (db) => {
    // Must be inside both the company AND the caller's permission scope (e.g. a manager's team).
    const employee = await db.employee.findFirst({
      where: { id: employeeId, ...employeeScopeWhere(ctx, "attendance.write") },
      select: { id: true, employeeCode: true, shiftId: true },
    });
    if (!employee) throw new Error("Employee not found");

    // Nobody edits a month whose payroll has already been marked as paid.
    const finalized = await db.payrollRun.findFirst({ where: { month, year, status: "FINALIZED" }, select: { id: true } });
    if (finalized) throw new Error("Payroll for this month is marked as paid, so its attendance can't be changed");

    const result = await saveAttendanceDays(db, ctx.companyId, employee, entries);
    await audit(db, ctx, {
      module: "attendance",
      action: "attendance.save",
      entityType: "Employee",
      entityId: employeeId,
      newValue: { employeeCode: employee.employeeCode, year, month, saved: result.saved, cleared: result.removed },
    });
  });

  revalidatePath("/attendance");
}
