import type { AttendanceStatus } from "@prisma/client";
import type { DayType } from "./calendar";

/** Everything the engine needs to know about a shift. Times are minutes after midnight. */
export interface ShiftDef {
  startMinutes: number;
  endMinutes: number;
  breakMinutes: number;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
  isFlexible: boolean;
  flexibleMinutes: number | null;
}

export interface RuleDef {
  absentIfNoRecord: boolean;
  lateAction: "MARK_LATE" | "HALF_DAY";
  lateHalfDayAfterMinutes: number | null;
  lateCountPerHalfDay: number;
  earlyLeaveAction: "MARK_EARLY" | "HALF_DAY";
  halfDayBelowMinutes: number;
  absentBelowMinutes: number;
  missingPunchAction: "PRESENT" | "HALF_DAY" | "ABSENT";
  otEnabled: boolean;
  otPayable: boolean;
  otMinMinutes: number;
  otMultiplier: number;
  otOnOffDays: boolean;
}

/** Minutes from shift start to shift end, crossing midnight if the end is not after the start. */
export function shiftSpanMinutes(shift: ShiftDef): number {
  return (shift.endMinutes - shift.startMinutes + 1440) % 1440 || 1440;
}

/** Working minutes a person is expected to put in (span minus break; flexible shifts use their own target). */
export function scheduledMinutes(shift: ShiftDef): number {
  if (shift.isFlexible) return shift.flexibleMinutes ?? 480;
  return Math.max(0, shiftSpanMinutes(shift) - shift.breakMinutes);
}

export interface DayInput {
  dayType: DayType;
  shift: ShiftDef;
  /** Minutes after local midnight of the attendance date. */
  inMinutes: number | null;
  /** Same axis as inMinutes; may be >= 1440 when the person clocked out after midnight. */
  outMinutes: number | null;
  /** An approved leave covers this day. */
  onLeave?: boolean;
}

export interface DayResult {
  /** null = nothing to record for this day (working day, no punches, absence rule off). */
  status: AttendanceStatus | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  flags: string[];
}

const SEVERITY: Record<string, number> = { PRESENT: 0, HALF_DAY: 1, ABSENT: 2 };
const worse = (a: AttendanceStatus, b: AttendanceStatus) => ((SEVERITY[b] ?? 0) > (SEVERITY[a] ?? 0) ? b : a);

/**
 * Turns one day's punches into a status plus late / early / overtime figures, using the shift and the
 * company's rules. Pure: no database, no clock.
 */
export function evaluateDay(input: DayInput, rules: RuleDef): DayResult {
  const { dayType, shift } = input;
  const result: DayResult = {
    status: null, workedMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, isLate: false, flags: [],
  };
  const offStatus: AttendanceStatus | null = dayType === "WEEKLY_OFF" ? "WEEK_OFF" : dayType === "HOLIDAY" ? "HOLIDAY" : null;
  const hasIn = input.inMinutes !== null;
  const hasOut = input.outMinutes !== null;

  // ---- No punches at all --------------------------------------------------------------------------
  if (!hasIn && !hasOut) {
    if (input.onLeave) result.status = "ON_LEAVE";
    else if (offStatus) result.status = offStatus;
    else if (rules.absentIfNoRecord) result.status = "ABSENT";
    return result;
  }

  // ---- Only one punch -----------------------------------------------------------------------------
  if (!hasIn || !hasOut) {
    result.flags.push("MISSING_PUNCH");
    result.status = offStatus ?? rules.missingPunchAction;
    if (hasIn && !shift.isFlexible) applyLate(result, input.inMinutes!, shift);
    return result;
  }

  // ---- Both punches -------------------------------------------------------------------------------
  const inM = input.inMinutes!;
  const outM = input.outMinutes! < inM ? input.outMinutes! + 1440 : input.outMinutes!;
  const gross = outM - inM;
  const worked = Math.max(0, gross > shift.breakMinutes ? gross - shift.breakMinutes : gross);
  result.workedMinutes = worked;

  if (!shift.isFlexible) {
    applyLate(result, inM, shift);
    const endAbs = shift.endMinutes + (shift.endMinutes <= shift.startMinutes ? 1440 : 0);
    if (outM < endAbs - shift.earlyLeaveGraceMinutes) result.earlyLeaveMinutes = endAbs - outM;
  }

  const scheduled = scheduledMinutes(shift);

  if (dayType === "WORKING") {
    let status: AttendanceStatus = "PRESENT";
    if (rules.absentBelowMinutes > 0 && worked < rules.absentBelowMinutes) status = worse(status, "ABSENT");
    else if (rules.halfDayBelowMinutes > 0 && worked < rules.halfDayBelowMinutes) status = worse(status, "HALF_DAY");
    if (
      result.isLate &&
      rules.lateAction === "HALF_DAY" &&
      (rules.lateHalfDayAfterMinutes === null || result.lateMinutes >= rules.lateHalfDayAfterMinutes)
    ) {
      status = worse(status, "HALF_DAY");
    }
    if (result.earlyLeaveMinutes > 0 && rules.earlyLeaveAction === "HALF_DAY") status = worse(status, "HALF_DAY");
    result.status = input.onLeave ? "ON_LEAVE" : status;

    if (rules.otEnabled) {
      const extra = worked - scheduled;
      if (extra >= rules.otMinMinutes) result.overtimeMinutes = extra;
    }
  } else {
    // Worked on a weekly off or holiday: the day keeps its status; the time is overtime if the policy says so.
    result.status = offStatus;
    if (rules.otEnabled && rules.otOnOffDays && worked >= rules.otMinMinutes) result.overtimeMinutes = worked;
  }

  return result;
}

function applyLate(result: DayResult, inM: number, shift: ShiftDef) {
  if (inM > shift.startMinutes + shift.lateGraceMinutes) {
    result.isLate = true;
    result.lateMinutes = inM - shift.startMinutes;
  }
}
