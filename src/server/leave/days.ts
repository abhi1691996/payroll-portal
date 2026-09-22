import type { TenantDb } from "@/server/tenancy/db";
import { countLeaveDays } from "@/lib/leave/planner";
import type { WeeklyPattern } from "@/lib/attendance/calendar";

/**
 * Approved leave, expanded to the individual dates that count, per employee. Used by attendance (an
 * approved leave day is not an absence) and by payroll (unpaid leave costs pay).
 */
export async function approvedLeaveMap(
  db: TenantDb,
  employeeIds: string[],
  from: Date,
  to: Date,
  pattern: WeeklyPattern,
  holidays: ReadonlySet<string>,
  defaultPolicyId: string | null
): Promise<Map<string, Map<string, { paid: boolean; half: boolean }>>> {
  const out = new Map<string, Map<string, { paid: boolean; half: boolean }>>();
  if (employeeIds.length === 0) return out;

  const requests = await db.leaveRequest.findMany({
    where: { employeeId: { in: employeeIds }, status: "APPROVED", startDate: { lte: to }, endDate: { gte: from } },
    include: { leaveType: true, employee: { select: { leavePolicyId: true } } },
  });
  if (requests.length === 0) return out;

  const rules = await db.leavePolicyRule.findMany({ where: { leaveTypeId: { in: [...new Set(requests.map((r) => r.leaveTypeId))] } } });
  const flags = new Map(rules.map((r) => [`${r.policyId}|${r.leaveTypeId}`, r]));

  for (const r of requests) {
    const rule = flags.get(`${r.employee.leavePolicyId ?? defaultPolicyId}|${r.leaveTypeId}`);
    const count = countLeaveDays({
      from: r.startDate > from ? r.startDate : from,
      to: r.endDate < to ? r.endDate : to,
      isHalfDay: r.isHalfDay,
      pattern,
      holidays,
      countWeeklyOffs: rule?.countWeeklyOffs ?? false,
      countHolidays: rule?.countHolidays ?? false,
    });
    let perEmployee = out.get(r.employeeId);
    if (!perEmployee) out.set(r.employeeId, (perEmployee = new Map()));
    for (const iso of count.chargeable) perEmployee.set(iso, { paid: r.leaveType.isPaid, half: r.isHalfDay });
  }
  return out;
}
