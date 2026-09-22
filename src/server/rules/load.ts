import type { CompanySetting, Shift } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { ensureCompanyDefaults } from "@/server/companies/defaults";
import { parsePattern, isoDate, type WeeklyPattern } from "@/lib/attendance/calendar";
import type { RuleDef, ShiftDef } from "@/lib/attendance/engine";

/** Used only if a company has somehow no shift at all: 9:30 - 6:30 with a 1 hour break. */
export const FALLBACK_SHIFT: ShiftDef = {
  startMinutes: 570, endMinutes: 1110, breakMinutes: 60, lateGraceMinutes: 15, earlyLeaveGraceMinutes: 15, isFlexible: false, flexibleMinutes: null,
};

export function toShiftDef(s: Shift): ShiftDef {
  return {
    startMinutes: s.startMinutes,
    endMinutes: s.endMinutes,
    breakMinutes: s.breakMinutes,
    lateGraceMinutes: s.lateGraceMinutes,
    earlyLeaveGraceMinutes: s.earlyLeaveGraceMinutes,
    isFlexible: s.isFlexible,
    flexibleMinutes: s.flexibleMinutes,
  };
}

export interface CompanyRules {
  pattern: WeeklyPattern;
  rules: RuleDef;
  setting: CompanySetting;
  shifts: Shift[];
  /** Resolves an employee's shift: their own, else the company default, else the first shift, else a fallback. */
  shiftFor: (employee: { shiftId: string | null }) => ShiftDef;
}

/** Loads every rule the attendance and leave engines need. Creates the defaults first if a company has none. */
export async function loadRules(db: TenantDb, companyId: string): Promise<CompanyRules> {
  let rule = await db.attendanceRule.findFirst();
  let setting = await db.companySetting.findFirst();
  if (!rule || !setting) {
    await ensureCompanyDefaults(db as never, companyId);
    rule = await db.attendanceRule.findFirstOrThrow();
    setting = await db.companySetting.findFirstOrThrow();
  }
  const shifts = await db.shift.findMany({ orderBy: { createdAt: "asc" } });
  const byId = new Map(shifts.map((s) => [s.id, s]));

  return {
    pattern: parsePattern(rule.weeklyPattern),
    setting,
    shifts,
    rules: {
      absentIfNoRecord: rule.absentIfNoRecord,
      lateAction: rule.lateAction,
      lateHalfDayAfterMinutes: rule.lateHalfDayAfterMinutes,
      lateCountPerHalfDay: rule.lateCountPerHalfDay,
      earlyLeaveAction: rule.earlyLeaveAction,
      halfDayBelowMinutes: rule.halfDayBelowMinutes,
      absentBelowMinutes: rule.absentBelowMinutes,
      missingPunchAction: rule.missingPunchAction,
      otEnabled: rule.otEnabled,
      otPayable: rule.otPayable,
      otMinMinutes: rule.otMinMinutes,
      otMultiplier: Number(rule.otMultiplier),
      otOnOffDays: rule.otOnOffDays,
    },
    shiftFor: (employee) => {
      const chosen = (employee.shiftId && byId.get(employee.shiftId)) || (setting.defaultShiftId && byId.get(setting.defaultShiftId)) || shifts[0];
      return chosen ? toShiftDef(chosen) : FALLBACK_SHIFT;
    },
  };
}

export async function loadHolidays(db: TenantDb, from: Date, to: Date): Promise<Set<string>> {
  const rows = await db.holiday.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true } });
  return new Set(rows.map((h) => isoDate(h.date)));
}
