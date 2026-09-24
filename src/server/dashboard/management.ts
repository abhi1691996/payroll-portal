import type { TenantDb } from "@/server/tenancy/db";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { approvedLeaveMap } from "@/server/leave/days";
import { classifyDay, isoDate } from "@/lib/attendance/calendar";
import { daysInMonth } from "@/lib/dates";
import { ROSTER_STATUSES } from "@/server/employees/lifecycle";

/**
 * The admin-only "Daily Management Dashboard": a one-day snapshot of workforce, attendance, payroll cost
 * and workforce-change counts. Every number here is a quick estimate for a daily glance, not a substitute
 * for the real attendance/payroll/offboarding screens (which is what each number's drill-down links to,
 * conceptually — `metricDetails` below returns the underlying rows for the same query).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Employees who were on the books for at least part of the given day — joined by then, not yet exited. */
async function employedOn(db: TenantDb, date: Date) {
  const nextDay = new Date(date.getTime() + 86_400_000);
  return db.employee.findMany({
    where: { dateOfJoining: { lt: nextDay }, OR: [{ dateOfExit: null }, { dateOfExit: { gte: date } }] },
    select: {
      id: true, employeeCode: true, firstName: true, lastName: true, department: true, status: true,
      dateOfBirth: true, dateOfJoining: true,
    },
  });
}

export interface DashboardMetrics {
  date: string;
  totalWorkforce: number;
  present: number;
  absent: number;
  wfh: number;
  halfDay: number;
  missedPunches: number;
  lateComings: number;
  earlyLeaves: number;
  birthdays: number;
  workAnniversaries: number;
  weekOff: number;
  dailyPayrollCost: number;
  departmentCount: number;
  departmentAttendance: { department: string; present: number; absent: number; wfh: number; halfDay: number; onLeave: number; total: number }[];
  suspensions: number;
  resignationsPending: number;
  terminationsToday: number;
}

export async function computeDashboardMetrics(db: TenantDb, companyId: string, date: Date): Promise<DashboardMetrics> {
  const iso = isoDate(date);

  const employees = await employedOn(db, date);
  const employeeIds = employees.map((e) => e.id);
  const rosterEmployees = employees.filter((e) => ROSTER_STATUSES.includes(e.status));

  const { pattern, setting, rules } = await loadRules(db, companyId);
  const holidays = await loadHolidays(db, date, date);
  const isWeeklyOffDay = classifyDay(date, pattern, holidays) === "WEEKLY_OFF";

  const records = await db.attendanceRecord.findMany({ where: { date, employeeId: { in: employeeIds } } });
  const recordByEmployee = new Map(records.map((r) => [r.employeeId, r]));

  const leaves = await approvedLeaveMap(db, employeeIds, date, date, pattern, holidays, setting.defaultLeavePolicyId);

  let present = 0, absent = 0, wfh = 0, halfDay = 0, missedPunches = 0, lateComings = 0, earlyLeaves = 0;
  const departmentMap = new Map<string, { department: string; present: number; absent: number; wfh: number; halfDay: number; onLeave: number; total: number }>();

  const salaries = await db.employeeSalary.findMany({ where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: date } }, orderBy: { effectiveFrom: "desc" } });
  const currentSalary = new Map<string, (typeof salaries)[number]>();
  for (const s of salaries) if (!currentSalary.has(s.employeeId)) currentSalary.set(s.employeeId, s);
  const dim = daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);

  let dailyPayrollCost = 0;

  for (const e of employees) {
    const dept = e.department || "Unassigned";
    const deptRow = departmentMap.get(dept) ?? { department: dept, present: 0, absent: 0, wfh: 0, halfDay: 0, onLeave: 0, total: 0 };
    deptRow.total += 1;

    const rec = recordByEmployee.get(e.id);
    const leaveEntry = leaves.get(e.id)?.get(iso);

    let paidFraction = 0;
    if (isWeeklyOffDay) { paidFraction = 1; }
    else if (rec?.status === "PRESENT") { present++; deptRow.present++; paidFraction = 1; }
    else if (rec?.status === "WFH") { wfh++; deptRow.wfh++; paidFraction = 1; }
    else if (rec?.status === "HALF_DAY") { halfDay++; deptRow.halfDay++; paidFraction = 0.5; }
    else if (rec?.status === "HOLIDAY") { paidFraction = 1; }
    else if (rec?.status === "ON_LEAVE" || leaveEntry) {
      deptRow.onLeave++;
      paidFraction = !leaveEntry || leaveEntry.paid ? (leaveEntry?.half ? 0.5 : 1) : 0;
    } else if (rec?.status === "ABSENT") { absent++; deptRow.absent++; paidFraction = 0; }
    else { paidFraction = rules.absentIfNoRecord ? 0 : 1; } // no record yet today: not marked absent unless the rule says so

    if (rec?.flags?.includes("MISSING_PUNCH")) missedPunches++;
    if (rec?.isLate) lateComings++;
    if (rec && rec.earlyLeaveMinutes > 0) earlyLeaves++;

    departmentMap.set(dept, deptRow);

    const salary = currentSalary.get(e.id);
    if (salary) dailyPayrollCost += (Number(salary.grossMonthly) / dim) * paidFraction;
  }

  const birthdays = rosterEmployees.filter(
    (e) => e.dateOfBirth && e.dateOfBirth.getUTCMonth() === date.getUTCMonth() && e.dateOfBirth.getUTCDate() === date.getUTCDate()
  ).length;
  const workAnniversaries = rosterEmployees.filter(
    (e) => e.dateOfJoining.getUTCMonth() === date.getUTCMonth() && e.dateOfJoining.getUTCDate() === date.getUTCDate() && e.dateOfJoining.getUTCFullYear() < date.getUTCFullYear()
  ).length;

  const suspensions = await db.employeeSuspension.count({ where: { fromDate: { lte: date }, OR: [{ toDate: null }, { toDate: { gte: date } }] } });
  const resignationsPending = await db.employeeSeparation.count({ where: { type: "RESIGNATION", status: "PENDING", submittedDate: { lte: date } } });
  const terminationsToday = await db.employeeSeparation.count({ where: { type: "TERMINATION", lastWorkingDay: date } });

  return {
    date: iso,
    totalWorkforce: employees.length,
    present, absent, wfh, halfDay, missedPunches, lateComings, earlyLeaves,
    birthdays, workAnniversaries,
    weekOff: isWeeklyOffDay ? employees.length : 0,
    dailyPayrollCost: round2(dailyPayrollCost),
    departmentCount: departmentMap.size,
    departmentAttendance: [...departmentMap.values()].sort((a, b) => a.department.localeCompare(b.department)),
    suspensions, resignationsPending, terminationsToday,
  };
}

export type DashboardMetricKey =
  | "totalWorkforce" | "present" | "absent" | "wfh" | "halfDay" | "missedPunches" | "lateComings" | "earlyLeaves"
  | "birthdays" | "workAnniversaries" | "weekOff" | "dailyPayrollCost" | "departments"
  | "suspensions" | "resignationsPending" | "terminationsToday";

export interface DetailRow {
  employeeCode: string;
  name: string;
  department: string;
  extra: string;
}

/** The underlying rows behind one stat card's number, for the drill-down table. */
export async function metricDetails(db: TenantDb, companyId: string, date: Date, metric: DashboardMetricKey): Promise<DetailRow[]> {
  const nameOf = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();
  const iso = isoDate(date);

  if (metric === "suspensions") {
    const rows = await db.employeeSuspension.findMany({
      where: { fromDate: { lte: date }, OR: [{ toDate: null }, { toDate: { gte: date } }] },
      include: { employee: { select: { employeeCode: true, firstName: true, lastName: true, department: true } } },
    });
    return rows.map((r) => ({ employeeCode: r.employee.employeeCode, name: nameOf(r.employee), department: r.employee.department || "Unassigned", extra: r.reason || "No reason given" }));
  }
  if (metric === "resignationsPending") {
    const rows = await db.employeeSeparation.findMany({
      where: { type: "RESIGNATION", status: "PENDING", submittedDate: { lte: date } },
      include: { employee: { select: { employeeCode: true, firstName: true, lastName: true, department: true } } },
    });
    return rows.map((r) => ({ employeeCode: r.employee.employeeCode, name: nameOf(r.employee), department: r.employee.department || "Unassigned", extra: `Submitted ${isoDate(r.submittedDate)}, last day ${isoDate(r.lastWorkingDay)}` }));
  }
  if (metric === "terminationsToday") {
    const rows = await db.employeeSeparation.findMany({
      where: { type: "TERMINATION", lastWorkingDay: date },
      include: { employee: { select: { employeeCode: true, firstName: true, lastName: true, department: true } } },
    });
    return rows.map((r) => ({ employeeCode: r.employee.employeeCode, name: nameOf(r.employee), department: r.employee.department || "Unassigned", extra: r.reason || "No reason given" }));
  }

  const employees = await employedOn(db, date);
  const employeeIds = employees.map((e) => e.id);
  const byId = new Map(employees.map((e) => [e.id, e]));

  if (metric === "totalWorkforce") {
    return employees.map((e) => ({ employeeCode: e.employeeCode, name: nameOf(e), department: e.department || "Unassigned", extra: e.status }));
  }
  if (metric === "birthdays") {
    return employees
      .filter((e) => ROSTER_STATUSES.includes(e.status) && e.dateOfBirth && e.dateOfBirth.getUTCMonth() === date.getUTCMonth() && e.dateOfBirth.getUTCDate() === date.getUTCDate())
      .map((e) => ({ employeeCode: e.employeeCode, name: nameOf(e), department: e.department || "Unassigned", extra: `Born ${isoDate(e.dateOfBirth!)}` }));
  }
  if (metric === "workAnniversaries") {
    return employees
      .filter((e) => ROSTER_STATUSES.includes(e.status) && e.dateOfJoining.getUTCMonth() === date.getUTCMonth() && e.dateOfJoining.getUTCDate() === date.getUTCDate() && e.dateOfJoining.getUTCFullYear() < date.getUTCFullYear())
      .map((e) => ({ employeeCode: e.employeeCode, name: nameOf(e), department: e.department || "Unassigned", extra: `${date.getUTCFullYear() - e.dateOfJoining.getUTCFullYear()} year(s), joined ${isoDate(e.dateOfJoining)}` }));
  }
  if (metric === "departments") {
    const metrics = await computeDashboardMetrics(db, companyId, date);
    return metrics.departmentAttendance.map((d) => ({
      employeeCode: "", department: d.department, name: d.department,
      extra: `${d.present} present · ${d.absent} absent · ${d.wfh} WFH · ${d.halfDay} half day · ${d.onLeave} on leave · ${d.total} total`,
    }));
  }
  if (metric === "weekOff") {
    const { pattern, setting } = await loadRules(db, companyId);
    const holidays = await loadHolidays(db, date, date);
    if (classifyDay(date, pattern, holidays) !== "WEEKLY_OFF") return [];
    void setting;
    return employees.map((e) => ({ employeeCode: e.employeeCode, name: nameOf(e), department: e.department || "Unassigned", extra: "Weekly off" }));
  }
  if (metric === "dailyPayrollCost") {
    const salaries = await db.employeeSalary.findMany({ where: { employeeId: { in: employeeIds }, effectiveFrom: { lte: date } }, orderBy: { effectiveFrom: "desc" } });
    const currentSalary = new Map<string, (typeof salaries)[number]>();
    for (const s of salaries) if (!currentSalary.has(s.employeeId)) currentSalary.set(s.employeeId, s);
    const dim = daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
    const { pattern, setting, rules } = await loadRules(db, companyId);
    const holidays = await loadHolidays(db, date, date);
    const isWeeklyOffDay = classifyDay(date, pattern, holidays) === "WEEKLY_OFF";
    const records = await db.attendanceRecord.findMany({ where: { date, employeeId: { in: employeeIds } } });
    const recordByEmployee = new Map(records.map((r) => [r.employeeId, r]));
    const leaves = await approvedLeaveMap(db, employeeIds, date, date, pattern, holidays, setting.defaultLeavePolicyId);

    const out: DetailRow[] = [];
    for (const e of employees) {
      const salary = currentSalary.get(e.id);
      if (!salary) continue;
      const rec = recordByEmployee.get(e.id);
      const leaveEntry = leaves.get(e.id)?.get(iso);
      let paidFraction = 0;
      if (isWeeklyOffDay || rec?.status === "PRESENT" || rec?.status === "WFH" || rec?.status === "HOLIDAY") paidFraction = 1;
      else if (rec?.status === "HALF_DAY") paidFraction = 0.5;
      else if (rec?.status === "ON_LEAVE" || leaveEntry) paidFraction = !leaveEntry || leaveEntry.paid ? (leaveEntry?.half ? 0.5 : 1) : 0;
      else if (rec?.status === "ABSENT") paidFraction = 0;
      else paidFraction = rules.absentIfNoRecord ? 0 : 1;
      const cost = round2((Number(salary.grossMonthly) / dim) * paidFraction);
      out.push({ employeeCode: e.employeeCode, name: nameOf(e), department: e.department || "Unassigned", extra: `Rs ${cost.toLocaleString("en-IN")}` });
    }
    return out;
  }

  // present / absent / wfh / halfDay / missedPunches / lateComings / earlyLeaves: driven by AttendanceRecord.
  const records = await db.attendanceRecord.findMany({ where: { date, employeeId: { in: employeeIds } } });
  const filtered = records.filter((r) => {
    if (metric === "present") return r.status === "PRESENT";
    if (metric === "absent") return r.status === "ABSENT";
    if (metric === "wfh") return r.status === "WFH";
    if (metric === "halfDay") return r.status === "HALF_DAY";
    if (metric === "missedPunches") return !!r.flags?.includes("MISSING_PUNCH");
    if (metric === "lateComings") return r.isLate;
    if (metric === "earlyLeaves") return r.earlyLeaveMinutes > 0;
    return false;
  });
  return filtered
    .map((r) => {
      const e = byId.get(r.employeeId);
      if (!e) return null;
      const extra =
        metric === "lateComings" ? `Late by ${r.lateMinutes} min`
        : metric === "earlyLeaves" ? `Left ${r.earlyLeaveMinutes} min early`
        : metric === "missedPunches" ? (r.flags ?? "")
        : r.status;
      return { employeeCode: e.employeeCode, name: nameOf(e), department: e.department || "Unassigned", extra };
    })
    .filter((r): r is DetailRow => r !== null);
}
