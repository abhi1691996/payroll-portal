import type { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_STATUTORY } from "@/server/compliance/defaults";
import { DEFAULT_WEEKLY_PATTERN } from "@/lib/attendance/calendar";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * The starting rules every company gets. All of it is ordinary company data that the admin edits or
 * replaces under Settings; nothing here is hard-wired into payroll. Idempotent: safe to call again.
 * (Companies that existed before these tables were added received the same defaults from the migration.)
 */
export const DEFAULT_COMPONENTS = [
  { code: "BASIC", name: "Basic", calcType: "PERCENT_OF_CTC", defaultValue: 50, isBasic: true, includeInPf: true, sortOrder: 1 },
  { code: "HRA", name: "HRA", calcType: "PERCENT_OF_BASIC", defaultValue: 40, isBasic: false, includeInPf: false, sortOrder: 2 },
  { code: "SPECIAL", name: "Special Allowance", calcType: "BALANCE", defaultValue: 0, isBasic: false, includeInPf: false, sortOrder: 3 },
  { code: "OTHER", name: "Other Allowances", calcType: "FIXED", defaultValue: 0, isBasic: false, includeInPf: false, sortOrder: 4 },
] as const;

export const DEFAULT_LEAVE_TYPES = [
  { code: "CASUAL_LEAVE", name: "Casual Leave", isPaid: true, days: 12 },
  { code: "SICK_LEAVE", name: "Sick Leave", isPaid: true, days: 8 },
  { code: "EARNED_LEAVE", name: "Earned Leave", isPaid: true, days: 15 },
  { code: "LOP", name: "Loss of Pay", isPaid: false, days: 0 },
] as const;

/** Leave types HR can add with one click; the company decides which ones it actually uses. */
export const LEAVE_TYPE_CATALOGUE = [
  { code: "CASUAL_LEAVE", name: "Casual Leave", isPaid: true },
  { code: "SICK_LEAVE", name: "Sick Leave", isPaid: true },
  { code: "EARNED_LEAVE", name: "Earned Leave", isPaid: true },
  { code: "PRIVILEGE_LEAVE", name: "Privilege Leave", isPaid: true },
  { code: "MATERNITY_LEAVE", name: "Maternity Leave", isPaid: true },
  { code: "PATERNITY_LEAVE", name: "Paternity Leave", isPaid: true },
  { code: "COMP_OFF", name: "Comp Off", isPaid: true },
  { code: "LOP", name: "Loss of Pay", isPaid: false },
] as const;

export async function ensureCompanyDefaults(db: Db, companyId: string): Promise<void> {
  // ---- Salary components + a starter template
  for (const c of DEFAULT_COMPONENTS) {
    await db.salaryComponent.upsert({
      where: { companyId_code: { companyId, code: c.code } },
      create: { companyId, ...c },
      update: {},
    });
  }
  if (!(await db.salaryTemplate.findFirst({ where: { companyId }, select: { id: true } }))) {
    const comps = await db.salaryComponent.findMany({ where: { companyId } });
    await db.salaryTemplate.create({
      data: {
        companyId,
        name: "Standard",
        description: "Starter structure - edit it or create your own under Settings -> Salary Rules.",
        lines: {
          // companyId is inherited from the parent through the composite relation.
          create: comps.map((c) => ({ componentId: c.id, calcType: c.calcType, value: c.defaultValue, sortOrder: c.sortOrder })),
        },
      },
    });
  }

  // ---- Shift
  let shift = await db.shift.findFirst({ where: { companyId }, orderBy: { createdAt: "asc" } });
  if (!shift) {
    shift = await db.shift.create({
      data: { companyId, name: "General", startMinutes: 570, endMinutes: 1110, breakMinutes: 60, lateGraceMinutes: 15, earlyLeaveGraceMinutes: 15 },
    });
  }

  // ---- Attendance rules (working week etc.)
  await db.attendanceRule.upsert({
    where: { companyId },
    create: { companyId, weeklyPattern: DEFAULT_WEEKLY_PATTERN as unknown as Prisma.InputJsonValue },
    update: {},
  });

  // ---- Leave types, a starter policy and its rules
  for (const t of DEFAULT_LEAVE_TYPES) {
    await db.leaveType.upsert({
      where: { companyId_code: { companyId, code: t.code } },
      create: { companyId, code: t.code, name: t.name, isPaid: t.isPaid },
      update: {},
    });
  }
  let policy = await db.leavePolicy.findFirst({ where: { companyId }, orderBy: { createdAt: "asc" } });
  if (!policy) {
    const types = await db.leaveType.findMany({ where: { companyId, isPaid: true } });
    policy = await db.leavePolicy.create({
      data: {
        companyId,
        name: "Standard",
        description: "Default leave policy",
        rules: {
          create: types.map((t) => ({
            leaveTypeId: t.id,
            entitlementDays: DEFAULT_LEAVE_TYPES.find((d) => d.code === t.code)?.days ?? 0,
            accrual: "UPFRONT" as const,
          })),
        },
      },
    });
  }

  // ---- Company settings pointing at the defaults
  await db.companySetting.upsert({
    where: { companyId },
    create: { companyId, defaultShiftId: shift.id, defaultLeavePolicyId: policy.id },
    update: {},
  });

  // ---- Approvals: leave and resignation both go to the reporting manager first (HR / admins can always decide)
  for (const [entityType, name] of [["LEAVE", "Leave approval"], ["RESIGNATION", "Resignation approval"]] as const) {
    const workflow = await db.approvalWorkflow.upsert({
      where: { companyId_entityType: { companyId, entityType } },
      create: { companyId, entityType, name },
      update: {},
    });
    if (!(await db.approvalLevel.findFirst({ where: { workflowId: workflow.id }, select: { id: true } }))) {
      await db.approvalLevel.create({ data: { companyId, workflowId: workflow.id, levelNo: 1, approverType: "REPORTING_MANAGER" } });
    }
  }

  // ---- Statutory rates
  if (!(await db.statutoryConfig.findFirst({ where: { companyId }, select: { id: true } }))) {
    await db.statutoryConfig.create({ data: { companyId, ...DEFAULT_STATUTORY } });
  }
}
