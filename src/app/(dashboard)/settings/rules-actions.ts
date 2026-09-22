"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { assertPermission } from "@/server/rbac/guard";
import { withTenant, type TenantDb } from "@/server/tenancy/db";
import { audit } from "@/server/audit/audit";
import { WEEKDAYS, type WeeklyPattern } from "@/lib/attendance/calendar";
import { validateTemplateLines } from "@/lib/salary/compute";
import { parseTimeToMinutes } from "@/lib/time";

const guard = () => assertPermission("settings.write", "COMPANY");
const flag = (fd: FormData, k: string) => fd.get(k) === "on";
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (fd: FormData, k: string, fallback = 0) => {
  const raw = str(fd, k);
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
  return n;
};

type Ctx = Awaited<ReturnType<typeof guard>>;
async function logChange(db: TenantDb, ctx: Ctx, action: string, entityType: string, entityId: string | undefined, oldValue: unknown, newValue: unknown) {
  await audit(db, ctx, { module: "settings", action, entityType, entityId, oldValue, newValue });
}

/* ------------------------------ Employee settings ------------------------------ */

export async function saveEmployeeSettings(formData: FormData) {
  const ctx = await guard();
  const prefix = str(formData, "employeeCodePrefix").toUpperCase();
  if (!/^[A-Z0-9-]{1,8}$/.test(prefix)) throw new Error("The code prefix can have up to 8 letters, digits or dashes");
  const regime = str(formData, "defaultTaxRegime") === "OLD" ? "OLD" : "NEW";

  await withTenant(ctx.companyId, async (db) => {
    const before = await db.companySetting.findFirstOrThrow();
    const shiftId = str(formData, "defaultShiftId") || null;
    const policyId = str(formData, "defaultLeavePolicyId") || null;
    if (shiftId && !(await db.shift.findUnique({ where: { id: shiftId } }))) throw new Error("Shift not found");
    if (policyId && !(await db.leavePolicy.findUnique({ where: { id: policyId } }))) throw new Error("Leave policy not found");
    const after = await db.companySetting.update({
      where: { id: before.id },
      data: { employeeCodePrefix: prefix, autoGenerateEmployeeCode: flag(formData, "autoGenerateEmployeeCode"), defaultTaxRegime: regime, defaultShiftId: shiftId, defaultLeavePolicyId: policyId },
    });
    await logChange(db, ctx, "settings.employee.update", "CompanySetting", after.id, before, after);
  });
  revalidatePath("/settings/employee");
}

/* -------------------------------- Salary rules --------------------------------- */

export async function saveSalaryComponent(formData: FormData) {
  const ctx = await guard();
  const id = str(formData, "id");
  const name = str(formData, "name");
  const calcType = str(formData, "calcType") as "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_CTC" | "BALANCE";
  if (!name) throw new Error("Give the component a name");
  if (!["FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_CTC", "BALANCE"].includes(calcType)) throw new Error("Choose how it is calculated");
  const isBasic = flag(formData, "isBasic");
  if (isBasic && (calcType === "PERCENT_OF_BASIC" || calcType === "BALANCE")) throw new Error("The Basic must be a fixed amount or a percentage of CTC");
  const data = {
    name, calcType, defaultValue: calcType === "BALANCE" ? 0 : num(formData, "defaultValue"), isBasic,
    taxable: flag(formData, "taxable"), includeInPf: flag(formData, "includeInPf"), includeInEsi: flag(formData, "includeInEsi"),
    includeInPt: flag(formData, "includeInPt"), active: flag(formData, "active"),
  };

  await withTenant(ctx.companyId, async (db) => {
    // Only one component is the Basic: making this one the Basic un-marks the previous one.
    if (isBasic) await db.salaryComponent.updateMany({ where: { isBasic: true, ...(id ? { id: { not: id } } : {}) }, data: { isBasic: false } });

    if (id) {
      const before = await db.salaryComponent.findUniqueOrThrow({ where: { id } });
      const after = await db.salaryComponent.update({ where: { id }, data });
      await logChange(db, ctx, "salary.component.update", "SalaryComponent", id, before, after);
    } else {
      const code = str(formData, "code").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (!code) throw new Error("Give the component a short code, e.g. CONV");
      if (await db.salaryComponent.findFirst({ where: { code } })) throw new Error(`A component with code ${code} already exists`);
      const last = await db.salaryComponent.findFirst({ orderBy: { sortOrder: "desc" } });
      const created = await db.salaryComponent.create({ data: { companyId: ctx.companyId, code, sortOrder: (last?.sortOrder ?? 0) + 1, ...data } });
      await logChange(db, ctx, "salary.component.create", "SalaryComponent", created.id, undefined, created);
    }
  });
  revalidatePath("/settings/salary");
}

interface LineInput { componentId: string; calcType: "FIXED" | "PERCENT_OF_BASIC" | "PERCENT_OF_CTC" | "BALANCE"; value: number }

export async function saveSalaryTemplate(formData: FormData) {
  const ctx = await guard();
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Give the structure a name");
  let lines: LineInput[];
  try {
    lines = JSON.parse(str(formData, "lines"));
  } catch {
    throw new Error("The component list couldn't be read");
  }
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("Add at least one component");

  await withTenant(ctx.companyId, async (db) => {
    const components = await db.salaryComponent.findMany({ where: { active: true } });
    const byId = new Map(components.map((c) => [c.id, c]));
    if (new Set(lines.map((l) => l.componentId)).size !== lines.length) throw new Error("A component can only appear once in a structure");
    for (const l of lines) if (!byId.has(l.componentId)) throw new Error("One of the components no longer exists");

    const problems = validateTemplateLines(lines.map((l) => ({ name: byId.get(l.componentId)!.name, calcType: l.calcType, isBasic: byId.get(l.componentId)!.isBasic })));
    if (problems.length) throw new Error(problems.join(". "));

    const lineData = lines.map((l, i) => ({
      componentId: l.componentId, calcType: l.calcType, value: l.calcType === "BALANCE" ? 0 : Number(l.value) || 0, sortOrder: byId.get(l.componentId)!.sortOrder * 10 + i,
    }));
    const base = { name, description: str(formData, "description") || null, active: flag(formData, "active") };

    if (id) {
      const before = await db.salaryTemplate.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      await db.salaryTemplateLine.deleteMany({ where: { templateId: id } });
      const after = await db.salaryTemplate.update({ where: { id }, data: { ...base, lines: { create: lineData } }, include: { lines: true } });
      await logChange(db, ctx, "salary.template.update", "SalaryTemplate", id, before, after);
    } else {
      if (await db.salaryTemplate.findFirst({ where: { name } })) throw new Error(`A structure called "${name}" already exists`);
      const created = await db.salaryTemplate.create({ data: { companyId: ctx.companyId, ...base, lines: { create: lineData } }, include: { lines: true } });
      await logChange(db, ctx, "salary.template.create", "SalaryTemplate", created.id, undefined, created);
    }
  });
  revalidatePath("/settings/salary");
}

/* ------------------------------------ Shifts ------------------------------------ */

export async function saveShift(formData: FormData) {
  const ctx = await guard();
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Give the shift a name");
  const isFlexible = flag(formData, "isFlexible");
  const start = parseTimeToMinutes(str(formData, "start") || "00:00");
  const end = parseTimeToMinutes(str(formData, "end") || "00:00");
  if (start === null || end === null) throw new Error("Enter the start and end as times, e.g. 09:30");
  if (!isFlexible && start === end) throw new Error("The start and end time can't be the same");
  const breakMinutes = Math.round(num(formData, "breakMinutes"));
  const flexibleMinutes = isFlexible ? Math.round(num(formData, "flexibleHours", 8) * 60) : null;
  if (breakMinutes < 0 || breakMinutes > 240) throw new Error("Break must be between 0 and 240 minutes");

  const data = {
    name, startMinutes: start, endMinutes: end, breakMinutes,
    lateGraceMinutes: Math.max(0, Math.round(num(formData, "lateGraceMinutes"))),
    earlyLeaveGraceMinutes: Math.max(0, Math.round(num(formData, "earlyLeaveGraceMinutes"))),
    isFlexible, flexibleMinutes, active: flag(formData, "active"),
  };

  await withTenant(ctx.companyId, async (db) => {
    if (id) {
      const before = await db.shift.findUniqueOrThrow({ where: { id } });
      if (!data.active) {
        const setting = await db.companySetting.findFirstOrThrow();
        if (setting.defaultShiftId === id) throw new Error("This is the company default shift; pick another default first");
      }
      const after = await db.shift.update({ where: { id }, data });
      await logChange(db, ctx, "shift.update", "Shift", id, before, after);
    } else {
      if (await db.shift.findFirst({ where: { name } })) throw new Error(`A shift called "${name}" already exists`);
      const created = await db.shift.create({ data: { companyId: ctx.companyId, ...data } });
      await logChange(db, ctx, "shift.create", "Shift", created.id, undefined, created);
    }
  });
  revalidatePath("/settings/shifts");
}

/* ------------------------------- Attendance rules ------------------------------- */

export async function saveAttendanceRules(formData: FormData) {
  const ctx = await guard();

  const pattern = {} as WeeklyPattern;
  for (const day of WEEKDAYS) {
    const mode = str(formData, `day_${day}`);
    if (mode === "OFF") pattern[day] = { mode: "OFF" };
    else if (mode === "ALTERNATE") {
      const weeks = [1, 2, 3, 4, 5].filter((w) => flag(formData, `week_${day}_${w}`));
      if (weeks.length === 0) throw new Error(`${day.toUpperCase()}: choose which weeks are off, or set it to Working / Off`);
      pattern[day] = { mode: "ALTERNATE", offWeeks: weeks };
    } else pattern[day] = { mode: "WORKING" };
  }
  if (WEEKDAYS.every((d) => pattern[d].mode === "OFF")) throw new Error("At least one day of the week must be a working day");

  const minutes = (k: string) => Math.max(0, Math.round(num(formData, k)));
  const data = {
    weeklyPattern: pattern as unknown as Prisma.InputJsonValue,
    absentIfNoRecord: flag(formData, "absentIfNoRecord"),
    lateAction: str(formData, "lateAction") === "HALF_DAY" ? ("HALF_DAY" as const) : ("MARK_LATE" as const),
    lateHalfDayAfterMinutes: str(formData, "lateHalfDayAfterMinutes") === "" ? null : minutes("lateHalfDayAfterMinutes"),
    lateCountPerHalfDay: minutes("lateCountPerHalfDay"),
    earlyLeaveAction: str(formData, "earlyLeaveAction") === "HALF_DAY" ? ("HALF_DAY" as const) : ("MARK_EARLY" as const),
    halfDayBelowMinutes: Math.round(num(formData, "halfDayBelowHours", 4) * 60),
    absentBelowMinutes: Math.round(num(formData, "absentBelowHours", 0) * 60),
    missingPunchAction: (["PRESENT", "HALF_DAY", "ABSENT"].includes(str(formData, "missingPunchAction")) ? str(formData, "missingPunchAction") : "PRESENT") as "PRESENT" | "HALF_DAY" | "ABSENT",
    otEnabled: flag(formData, "otEnabled"),
    otPayable: flag(formData, "otEnabled") && flag(formData, "otPayable"),
    otMinMinutes: minutes("otMinMinutes"),
    otMultiplier: Math.max(1, num(formData, "otMultiplier", 1.5)),
    otOnOffDays: flag(formData, "otOnOffDays"),
  };
  if (data.absentBelowMinutes > 0 && data.absentBelowMinutes > data.halfDayBelowMinutes) throw new Error("The 'absent below' hours can't be more than the 'half day below' hours");

  await withTenant(ctx.companyId, async (db) => {
    const before = await db.attendanceRule.findFirstOrThrow();
    const after = await db.attendanceRule.update({ where: { id: before.id }, data });
    await logChange(db, ctx, "attendance.rules.update", "AttendanceRule", after.id, before, after);
  });
  revalidatePath("/settings/attendance");
}

export async function addHoliday(formData: FormData) {
  const ctx = await guard();
  const date = new Date(`${str(formData, "date")}T00:00:00Z`);
  const name = str(formData, "name");
  if (Number.isNaN(date.getTime()) || !name) throw new Error("Choose a date and give the holiday a name");
  await withTenant(ctx.companyId, async (db) => {
    if (await db.holiday.findFirst({ where: { date } })) throw new Error("There is already a holiday on that date");
    const created = await db.holiday.create({ data: { companyId: ctx.companyId, date, name } });
    await logChange(db, ctx, "holiday.create", "Holiday", created.id, undefined, created);
  });
  revalidatePath("/settings/attendance");
}

export async function deleteHoliday(id: string) {
  const ctx = await guard();
  await withTenant(ctx.companyId, async (db) => {
    const before = await db.holiday.findUniqueOrThrow({ where: { id } });
    await db.holiday.delete({ where: { id } });
    await logChange(db, ctx, "holiday.delete", "Holiday", id, before, undefined);
  });
  revalidatePath("/settings/attendance");
}

/* ---------------------------------- Leave rules --------------------------------- */

export async function saveLeaveType(formData: FormData) {
  const ctx = await guard();
  const id = str(formData, "id");
  const name = str(formData, "name");
  if (!name) throw new Error("Give the leave type a name");
  await withTenant(ctx.companyId, async (db) => {
    if (id) {
      const before = await db.leaveType.findUniqueOrThrow({ where: { id } });
      const after = await db.leaveType.update({ where: { id }, data: { name, isPaid: flag(formData, "isPaid"), active: flag(formData, "active") } });
      await logChange(db, ctx, "leave.type.update", "LeaveType", id, before, after);
    } else {
      const code = (str(formData, "code") || name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
      if (await db.leaveType.findFirst({ where: { OR: [{ code }, { name }] } })) throw new Error(`A leave type called "${name}" already exists`);
      const created = await db.leaveType.create({ data: { companyId: ctx.companyId, code, name, isPaid: flag(formData, "isPaid") } });
      await logChange(db, ctx, "leave.type.create", "LeaveType", created.id, undefined, created);
    }
  });
  revalidatePath("/settings/leave");
}

export async function createLeavePolicy(formData: FormData) {
  const ctx = await guard();
  const name = str(formData, "name");
  if (!name) throw new Error("Give the policy a name");
  await withTenant(ctx.companyId, async (db) => {
    if (await db.leavePolicy.findFirst({ where: { name } })) throw new Error(`A policy called "${name}" already exists`);
    const created = await db.leavePolicy.create({ data: { companyId: ctx.companyId, name, description: str(formData, "description") || null } });
    await logChange(db, ctx, "leave.policy.create", "LeavePolicy", created.id, undefined, created);
  });
  revalidatePath("/settings/leave");
}

/** Saves every rule of one policy at once: one row per leave type, included only when its checkbox is ticked. */
export async function saveLeavePolicy(policyId: string, formData: FormData) {
  const ctx = await guard();
  await withTenant(ctx.companyId, async (db) => {
    const policy = await db.leavePolicy.findUniqueOrThrow({ where: { id: policyId }, include: { rules: true } });
    const types = await db.leaveType.findMany({ where: { isPaid: true } });

    const rules: Prisma.LeavePolicyRuleCreateManyInput[] = [];
    for (const t of types) {
      if (!flag(formData, `use_${t.id}`)) continue;
      const entitlement = num(formData, `ent_${t.id}`);
      if (entitlement < 0 || entitlement > 366) throw new Error(`${t.name}: entitlement must be between 0 and 366 days`);
      const carry = flag(formData, `carry_${t.id}`);
      const maxCarry = str(formData, `maxcarry_${t.id}`);
      const maxBal = str(formData, `maxbal_${t.id}`);
      const maxConsec = str(formData, `maxconsec_${t.id}`);
      rules.push({
        companyId: ctx.companyId, policyId, leaveTypeId: t.id, entitlementDays: entitlement,
        accrual: str(formData, `acc_${t.id}`) === "MONTHLY" ? "MONTHLY" : "UPFRONT",
        carryForward: carry, maxCarryForwardDays: carry && maxCarry !== "" ? Number(maxCarry) : null,
        maxBalance: maxBal !== "" ? Number(maxBal) : null, encashable: flag(formData, `enc_${t.id}`), allowHalfDay: flag(formData, `half_${t.id}`),
        maxConsecutiveDays: maxConsec !== "" ? Math.round(Number(maxConsec)) : null,
        countWeeklyOffs: flag(formData, `wo_${t.id}`), countHolidays: flag(formData, `hol_${t.id}`),
      });
    }
    await db.leavePolicyRule.deleteMany({ where: { policyId } });
    if (rules.length) await db.leavePolicyRule.createMany({ data: rules });
    await db.leavePolicy.update({ where: { id: policyId }, data: { active: flag(formData, "active"), name: str(formData, "name") || policy.name } });
    await logChange(db, ctx, "leave.policy.update", "LeavePolicy", policyId, policy.rules, rules);
  });
  revalidatePath("/settings/leave");
}

export async function saveLeaveYear(formData: FormData) {
  const ctx = await guard();
  const month = Math.round(num(formData, "leaveYearStartMonth", 1));
  if (month < 1 || month > 12) throw new Error("Choose a month");
  await withTenant(ctx.companyId, async (db) => {
    const before = await db.companySetting.findFirstOrThrow();
    await db.companySetting.update({ where: { id: before.id }, data: { leaveYearStartMonth: month } });
    await logChange(db, ctx, "leave.year.update", "CompanySetting", before.id, { leaveYearStartMonth: before.leaveYearStartMonth }, { leaveYearStartMonth: month });
  });
  revalidatePath("/settings/leave");
}

/* --------------------------------- Approval rules -------------------------------- */

/** Replaces the levels of the leave workflow. Requests already in flight keep the levels they were submitted with. */
export async function saveLeaveWorkflow(formData: FormData) {
  const ctx = await guard();
  await withTenant(ctx.companyId, async (db) => {
    const workflow = await db.approvalWorkflow.findFirstOrThrow({ where: { entityType: "LEAVE" } });
    const roles = await db.role.findMany({ select: { key: true } });
    const roleKeys = new Set(roles.map((r) => r.key));

    const levels: { approverType: "REPORTING_MANAGER" | "ROLE"; roleKey: string | null }[] = [];
    for (let i = 1; i <= 4; i++) {
      const type = str(formData, `level_${i}_type`);
      if (type === "REPORTING_MANAGER") levels.push({ approverType: "REPORTING_MANAGER", roleKey: null });
      else if (type === "ROLE") {
        const roleKey = str(formData, `level_${i}_role`);
        if (!roleKeys.has(roleKey)) throw new Error(`Level ${i}: choose a role`);
        levels.push({ approverType: "ROLE", roleKey });
      }
    }
    const before = await db.approvalLevel.findMany({ where: { workflowId: workflow.id }, orderBy: { levelNo: "asc" } });
    await db.approvalLevel.deleteMany({ where: { workflowId: workflow.id } });
    if (levels.length) {
      await db.approvalLevel.createMany({ data: levels.map((l, i) => ({ companyId: ctx.companyId, workflowId: workflow.id, levelNo: i + 1, ...l })) });
    }
    await logChange(db, ctx, "approval.workflow.update", "ApprovalWorkflow", workflow.id, before.map((l) => ({ level: l.levelNo, type: l.approverType, role: l.roleKey })), levels);
  });
  revalidatePath("/settings/approvals");
}
