import type { AttendanceStatus } from "@prisma/client";
import { classifyDay, eachDate, isoDate, type WeeklyPattern } from "./calendar";

export interface LopInput {
  year: number;
  month: number;
  pattern: WeeklyPattern;
  holidays: ReadonlySet<string>;
  /** Recorded attendance by ISO date. */
  records: ReadonlyMap<string, { status: AttendanceStatus; isLate: boolean }>;
  /** Approved leave by ISO date (only dates that count as leave). half = half-day leave. */
  leaves: ReadonlyMap<string, { paid: boolean; half: boolean }>;
  absentIfNoRecord: boolean;
  /** Every N late marks in the month cost half a day. 0 = off. */
  lateCountPerHalfDay: number;
  basis: "CALENDAR_DAYS" | "WORKING_DAYS";
  /**
   * Working days (ISO) the employee was suspended on. Unconditionally unpaid for that day — whatever
   * attendance or leave says is ignored — but the employee is still employed the rest of the month, so
   * weekly offs/holidays inside a suspension are untouched, same as any other absence.
   */
  excludedDates?: ReadonlySet<string>;
  /**
   * The last calendar day this month the employee was actually employed (their last working day, on a
   * resignation or termination). Every day after it is unpaid — unlike a suspension, this includes
   * weekly offs and holidays too, because there is no employment for them to be paid as part of.
   * `daysInPeriod` is NOT reduced by this (pay is still `monthlyAmount * paidDays / daysInPeriod`, so
   * the full month has to stay the denominator, exactly like an ordinary loss-of-pay day) — only
   * `paidDays` shrinks. Omit if they were employed for the whole month.
   */
  employedThrough?: Date;
}

export interface LopResult {
  /** Days in the pay period on the chosen basis — always the full month, whatever `employedThrough` says. */
  daysInPeriod: number;
  /** Working days in the month, whatever the basis. */
  workingDays: number;
  lopDays: number;
  absentDays: number;
  halfDays: number;
  unpaidLeaveDays: number;
  lateMarks: number;
  lateHalfDays: number;
  /** Of `lopDays`, how many came from `excludedDates` (suspension). */
  excludedDays: number;
  /** Of `lopDays`, how many fell after `employedThrough`. */
  separatedDays: number;
}

/**
 * How many days of pay to cut for a month. Sources of loss of pay:
 *  - a recorded Absent (1) or Half Day (0.5)
 *  - a working day with no record at all, when the company has turned on "no attendance = absent"
 *  - approved UNPAID leave (Loss of Pay)
 *  - repeated late arrivals, when the company converts N lates into a half day
 *  - a working day the employee was suspended on
 *  - any day (working or not) after `employedThrough`
 * Weekly offs and holidays never cost pay, unless they fall after `employedThrough` — there is no
 * "day off" once employment itself has ended.
 */
export function computeLop(input: LopInput): LopResult {
  const first = new Date(Date.UTC(input.year, input.month - 1, 1));
  const last = new Date(Date.UTC(input.year, input.month, 0));
  const dates = eachDate(first, last);

  let absent = 0, half = 0, unpaidLeave = 0, lateMarks = 0, workingDays = 0, excluded = 0, separated = 0;

  for (const d of dates) {
    const key = isoDate(d);
    const type = classifyDay(d, input.pattern, input.holidays);
    if (type === "WORKING") workingDays++;

    if (input.employedThrough && d > input.employedThrough) { separated++; continue; } // no employment at all past this point
    if (type !== "WORKING") continue; // weekly offs / holidays never cost pay while still employed

    if (input.excludedDates?.has(key)) { excluded++; continue; } // suspension wins over whatever attendance or leave says

    const record = input.records.get(key);
    const leave = input.leaves.get(key);

    if (leave && !leave.paid) {
      unpaidLeave += leave.half ? 0.5 : 1;
      // A half-day unpaid leave plus an Absent record shouldn't double count: the leave wins.
      continue;
    }
    if (record) {
      if (record.status === "ABSENT") absent += 1;
      else if (record.status === "HALF_DAY") half += 0.5;
      else if (record.status === "PRESENT" && record.isLate) lateMarks++;
      continue;
    }
    if (leave) continue; // paid leave
    if (input.absentIfNoRecord) absent += 1;
  }

  const lateHalfDays = input.lateCountPerHalfDay > 0 ? Math.floor(lateMarks / input.lateCountPerHalfDay) * 0.5 : 0;
  const daysInPeriod = input.basis === "WORKING_DAYS" ? workingDays : dates.length;
  const lopDays = Math.min(daysInPeriod, absent + half + unpaidLeave + lateHalfDays + excluded + separated);
  return { daysInPeriod, workingDays, lopDays, absentDays: absent, halfDays: half, unpaidLeaveDays: unpaidLeave, lateMarks, lateHalfDays, excludedDays: excluded, separatedDays: separated };
}
