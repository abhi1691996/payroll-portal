"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { ensureLifecycleStatuses } from "@/server/employees/lifecycle";
import { approvedLeaveMap } from "@/server/leave/days";
import { readLines } from "@/server/salary/service";
import { classifyDay, eachDate, isoDate } from "@/lib/attendance/calendar";
import { scheduledMinutes } from "@/lib/attendance/engine";
import { computeLop } from "@/lib/attendance/lop";
import { calculatePayrollFromLines, type EarningLineInput } from "@/lib/payroll-calculations";
import { getStatutoryConfigFor } from "@/lib/statutory-config";
import type { Prisma } from "@prisma/client";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Creates a payroll run for the given month/year and computes every active employee's payslip in one
 * transaction. Re-running for the same month replaces existing payslips as long as the run hasn't been
 * finalized yet.
 *
 * Loss of pay comes from the company's own rules: its working week and holidays, recorded attendance,
 * approved unpaid leave, and (if switched on) "no attendance = absent" and late-mark deductions.
 */
export async function processPayrollRun(formData: FormData) {
  const ctx = await assertPermission("payroll.run", "COMPANY");

  const year = Number(formData.get("year"));
  const month = Number(formData.get("month"));
  if (!year || !month || month < 1 || month > 12) {
    throw new Error("Invalid month/year");
  }

  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month, 0));

  const runId = await withTenant(
    ctx.companyId,
    async (db) => {
      const existingRun = await db.payrollRun.findUnique({
        where: { companyId_month_year: { companyId: ctx.companyId, month, year } },
      });
      if (existingRun?.status === "FINALIZED") {
        throw new Error("This payroll run is already finalized and cannot be reprocessed");
      }

      await ensureLifecycleStatuses(db);
      const statutoryConfig = await getStatutoryConfigFor(db, periodStart);
      const { pattern, rules, setting, shiftFor } = await loadRules(db, ctx.companyId);
      const holidays = await loadHolidays(db, periodStart, lastDay);

      // Anyone employed for at least part of this period, whatever their status is TODAY: a resignation or
      // termination only excludes the days after the employee's last working day, not the whole run, and a
      // past month must still be payable for someone who has since left.
      const employees = await db.employee.findMany({
        where: {
          dateOfJoining: { lt: periodEnd },
          OR: [{ dateOfExit: null }, { dateOfExit: { gte: periodStart } }],
        },
        include: {
          salaries: { where: { effectiveFrom: { lt: periodEnd } }, orderBy: { effectiveFrom: "desc" }, take: 1 },
          attendanceRecords: { where: { date: { gte: periodStart, lt: periodEnd } } },
          suspensions: { where: { fromDate: { lt: periodEnd }, OR: [{ toDate: null }, { toDate: { gte: periodStart } }] } },
        },
      });
      const leaves = await approvedLeaveMap(db, employees.map((e) => e.id), periodStart, lastDay, pattern, holidays, setting.defaultLeavePolicyId);
      const workingDaysInMonth = eachDate(periodStart, lastDay).filter((d) => classifyDay(d, pattern, holidays) === "WORKING").length;

      const run = await db.payrollRun.upsert({
        where: { companyId_month_year: { companyId: ctx.companyId, month, year } },
        create: { companyId: ctx.companyId, month, year, status: "PROCESSED", createdById: ctx.userId, processedAt: new Date() },
        update: { status: "PROCESSED", processedAt: new Date() },
      });

      const payslipRows: Prisma.PayslipCreateManyInput[] = [];
      let skipped = 0;

      for (const employee of employees) {
        const salary = employee.salaries[0];
        if (!salary) { skipped++; continue; } // no salary set yet -- skip, admin must configure it first

        // Suspended working days are unpaid but the employee is still on the books the rest of the month
        // (folded into loss of pay, weekly offs untouched). Days after their last working day are unpaid
        // outright, weekly offs included — there's no employment for those days to be part of.
        const excludedDates = new Set<string>();
        for (const s of employee.suspensions) {
          const from = s.fromDate > periodStart ? s.fromDate : periodStart;
          const to = s.toDate && s.toDate < lastDay ? s.toDate : lastDay;
          for (const d of eachDate(from, to)) excludedDates.add(isoDate(d));
        }
        const employedThrough = employee.dateOfExit && employee.dateOfExit < lastDay ? employee.dateOfExit : undefined;

        const lop = computeLop({
          year, month, pattern, holidays, basis: setting.lopBasis,
          records: new Map(employee.attendanceRecords.map((r) => [isoDate(r.date), { status: r.status, isLate: r.isLate }])),
          leaves: leaves.get(employee.id) ?? new Map(),
          absentIfNoRecord: rules.absentIfNoRecord,
          lateCountPerHalfDay: rules.lateCountPerHalfDay,
          excludedDates,
          employedThrough,
        });

        const lines: EarningLineInput[] = readLines(salary.lines).map((l) => ({
          code: l.code, name: l.name, monthlyAmount: l.monthlyAmount, isBasic: l.isBasic, taxable: l.taxable,
          includeInPf: l.includeInPf, includeInEsi: l.includeInEsi, includeInPt: l.includeInPt,
        }));

        // Overtime: hours are tracked for everyone; they are PAID only if the company's policy says so.
        const overtimeMinutes = employee.attendanceRecords.reduce((s, r) => s + r.overtimeMinutes, 0);
        if (rules.otEnabled && rules.otPayable && overtimeMinutes > 0) {
          const basicMonthly = lines.filter((l) => l.isBasic).reduce((s, l) => s + l.monthlyAmount, 0);
          const hoursPerDay = scheduledMinutes(shiftFor(employee)) / 60;
          const hourly = workingDaysInMonth > 0 && hoursPerDay > 0 ? basicMonthly / (workingDaysInMonth * hoursPerDay) : 0;
          const amount = round2((overtimeMinutes / 60) * hourly * rules.otMultiplier);
          if (amount > 0) {
            lines.push({ code: "OT", name: `Overtime (${(overtimeMinutes / 60).toFixed(1)} h × ${rules.otMultiplier})`, monthlyAmount: amount,
              taxable: true, includeInPf: false, includeInEsi: true, includeInPt: true, prorate: false });
          }
        }

        const breakdown = calculatePayrollFromLines(
          { lines, employerPfOptIn: salary.employerPfOptIn, taxRegime: employee.taxRegime },
          { daysInPeriod: lop.daysInPeriod, paidDays: lop.daysInPeriod - lop.lopDays },
          statutoryConfig
        );
        breakdown.attendanceSummary = {
          absentDays: lop.absentDays, halfDays: lop.halfDays, unpaidLeaveDays: lop.unpaidLeaveDays,
          lateMarks: lop.lateMarks, lateHalfDays: lop.lateHalfDays, overtimeMinutes,
          suspendedDays: lop.excludedDays, separatedDays: lop.separatedDays,
        };

        payslipRows.push({
          companyId: ctx.companyId,
          payrollRunId: run.id,
          employeeId: employee.id,
          grossPay: breakdown.grossPay,
          totalDeductions: breakdown.totalDeductions,
          netPay: breakdown.netPay,
          breakdown: breakdown as unknown as Prisma.InputJsonValue,
        });
      }

      await db.payslip.deleteMany({ where: { payrollRunId: run.id } });
      await db.payslip.createMany({ data: payslipRows });

      await audit(db, ctx, {
        module: "payroll",
        action: existingRun ? "payroll.recalculate" : "payroll.calculate",
        entityType: "PayrollRun",
        entityId: run.id,
        oldValue: existingRun ? { status: existingRun.status } : undefined,
        newValue: { month, year, payslips: payslipRows.length, skippedNoSalary: skipped },
      });

      return run.id;
    },
    { timeout: 60_000 }
  );

  revalidatePath("/payroll/runs");
  redirect(`/payroll/runs/${runId}`);
}

export async function finalizePayrollRun(runId: string) {
  const ctx = await assertPermission("payroll.finalize", "COMPANY");

  await withTenant(ctx.companyId, async (db) => {
    const run = await db.payrollRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error("Payroll run not found");
    if (run.status === "FINALIZED") throw new Error("This run is already finalized");

    await db.payrollRun.update({
      where: { id: runId },
      data: { status: "FINALIZED", finalizedAt: new Date() },
    });
    await audit(db, ctx, {
      module: "payroll",
      action: "payroll.finalize",
      entityType: "PayrollRun",
      entityId: runId,
      oldValue: { status: run.status },
      newValue: { status: "FINALIZED", month: run.month, year: run.year },
    });
  });

  revalidatePath(`/payroll/runs/${runId}`);
}
