import type { LedgerKind } from "@prisma/client";
import { classifyDay, eachDate, isoDate, type WeeklyPattern } from "../attendance/calendar";

/**
 * The leave engine's arithmetic. Balances are never stored: they are the SUM of ledger entries. This file
 * decides which automatic entries (accruals, year-end lapses) should exist; callers insert only the ones
 * whose `period` is not already in the ledger, which makes running it repeatedly harmless.
 */

export interface LedgerEntryIn {
  kind: LedgerKind;
  days: number;
  effectiveDate: Date;
  period: string | null;
}

export interface PlannedEntry {
  kind: "ACCRUAL" | "LAPSE";
  days: number;
  effectiveDate: Date;
  period: string;
  note: string;
}

export interface AccrualRule {
  entitlementDays: number;
  accrual: "UPFRONT" | "MONTHLY";
  carryForward: boolean;
  /** null = the whole balance carries forward (when carryForward is on). */
  maxCarryForwardDays: number | null;
  /** null = no cap. */
  maxBalance: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const utc = (y: number, m0: number, d = 1) => new Date(Date.UTC(y, m0, d));

/** The leave year a date belongs to, named after the calendar year in which it starts. */
export function leaveYearOf(date: Date, startMonth: number): number {
  const y = date.getUTCFullYear();
  return date.getUTCMonth() + 1 >= startMonth ? y : y - 1;
}

export function leaveYearStart(year: number, startMonth: number): Date {
  return utc(year, startMonth - 1, 1);
}

export function sumDays(entries: { days: number }[]): number {
  return round2(entries.reduce((s, e) => s + e.days, 0));
}

export function planLedger(input: {
  joinDate: Date;
  rule: AccrualRule;
  entries: LedgerEntryIn[];
  asOf: Date;
  startMonth: number;
}): PlannedEntry[] {
  const { joinDate, rule, asOf, startMonth } = input;
  const all: { days: number; effectiveDate: Date }[] = input.entries.map((e) => ({ days: e.days, effectiveDate: e.effectiveDate }));
  const existing = new Set(input.entries.map((e) => e.period).filter((p): p is string => !!p));
  const openings = input.entries.filter((e) => e.kind === "OPENING").map((e) => e.effectiveDate.getTime());
  // Anything dated on or before the latest opening balance is already included in it.
  const coveredUntil = openings.length ? Math.max(...openings) : null;
  const covered = (d: Date) => coveredUntil !== null && d.getTime() <= coveredUntil;

  const planned: PlannedEntry[] = [];
  const balanceWhere = (pred: (d: Date) => boolean) => round2(all.filter((e) => pred(e.effectiveDate)).reduce((s, e) => s + e.days, 0));
  const push = (e: PlannedEntry) => {
    planned.push(e);
    all.push({ days: e.days, effectiveDate: e.effectiveDate });
  };
  const capped = (amount: number, date: Date): number => {
    if (rule.maxBalance === null) return amount;
    const room = rule.maxBalance - balanceWhere((d) => d.getTime() <= date.getTime());
    return Math.max(0, Math.min(amount, round2(room)));
  };

  const currentYear = leaveYearOf(asOf, startMonth);
  const earliest = input.entries.length ? Math.min(...input.entries.map((e) => e.effectiveDate.getTime())) : null;
  const firstYear = earliest === null ? currentYear : Math.min(currentYear, leaveYearOf(new Date(earliest), startMonth));

  for (let year = firstYear; year <= currentYear; year++) {
    const yStart = leaveYearStart(year, startMonth);
    const yNext = leaveYearStart(year + 1, startMonth);

    // Year-end: whatever cannot be carried forward lapses on the first day of the new leave year.
    if (year > firstYear) {
      const period = `LAPSE:${year}`;
      if (!existing.has(period) && !covered(yStart) && yStart.getTime() <= asOf.getTime()) {
        const balance = balanceWhere((d) => d.getTime() < yStart.getTime());
        const keep = rule.carryForward ? (rule.maxCarryForwardDays === null ? balance : Math.min(balance, rule.maxCarryForwardDays)) : 0;
        const lapse = round2(balance - keep);
        if (lapse > 0.004) {
          push({ kind: "LAPSE", days: -lapse, effectiveDate: yStart, period, note: `Balance not carried forward into ${year}` });
        }
      }
    }

    if (rule.accrual === "UPFRONT") {
      const period = `ACC:${year}`;
      const joinedThisYear = joinDate.getTime() >= yStart.getTime() && joinDate.getTime() < yNext.getTime();
      let date = yStart;
      let amount = rule.entitlementDays;
      if (joinedThisYear) {
        // Pro-rate for the months left in the leave year, counting the joining month.
        const monthsIn = (joinDate.getUTCFullYear() - yStart.getUTCFullYear()) * 12 + joinDate.getUTCMonth() - yStart.getUTCMonth();
        amount = round2((rule.entitlementDays * (12 - monthsIn)) / 12);
        date = joinDate;
      }
      if (joinDate.getTime() < yNext.getTime() && !existing.has(period) && date.getTime() <= asOf.getTime() && !covered(date)) {
        const final = capped(amount, date);
        if (final > 0) push({ kind: "ACCRUAL", days: final, effectiveDate: date, period, note: "Annual entitlement" });
      }
    } else {
      for (let m = 0; m < 12; m++) {
        const monthStart = utc(yStart.getUTCFullYear(), yStart.getUTCMonth() + m, 1);
        if (monthStart.getTime() > asOf.getTime()) break;
        const monthEnd = utc(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1);
        if (joinDate.getTime() >= monthEnd.getTime()) continue; // hadn't joined yet
        const period = `ACC:${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, "0")}`;
        if (existing.has(period) || covered(monthStart)) continue;
        const final = capped(round2(rule.entitlementDays / 12), monthStart);
        if (final > 0) push({ kind: "ACCRUAL", days: final, effectiveDate: monthStart, period, note: "Monthly accrual" });
      }
    }
  }
  return planned;
}

export interface LeaveDayCount {
  /** Days counted against the balance. */
  days: number;
  /** The dates that count (ISO), used later for attendance / loss-of-pay. */
  chargeable: string[];
  skippedWeeklyOffs: number;
  skippedHolidays: number;
}

/** Counts the days a leave application costs, leaving out weekly offs / holidays unless the policy counts them. */
export function countLeaveDays(input: {
  from: Date;
  to: Date;
  isHalfDay: boolean;
  pattern: WeeklyPattern;
  holidays: ReadonlySet<string>;
  countWeeklyOffs: boolean;
  countHolidays: boolean;
}): LeaveDayCount {
  const chargeable: string[] = [];
  let skippedWeeklyOffs = 0;
  let skippedHolidays = 0;
  for (const d of eachDate(input.from, input.to)) {
    const type = classifyDay(d, input.pattern, input.holidays);
    if (type === "WORKING" || (type === "WEEKLY_OFF" && input.countWeeklyOffs) || (type === "HOLIDAY" && input.countHolidays)) {
      chargeable.push(isoDate(d));
    } else if (type === "WEEKLY_OFF") skippedWeeklyOffs++;
    else skippedHolidays++;
  }
  const days = input.isHalfDay ? (chargeable.length > 0 ? 0.5 : 0) : chargeable.length;
  return { days, chargeable, skippedWeeklyOffs, skippedHolidays };
}
