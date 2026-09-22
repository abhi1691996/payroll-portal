import { describe, expect, it } from "vitest";
import { classifyDay, isWeeklyOff, parsePattern, DEFAULT_WEEKLY_PATTERN, type WeeklyPattern } from "./calendar";
import { evaluateDay, scheduledMinutes, type RuleDef, type ShiftDef } from "./engine";
import { computeLop } from "./lop";
import { formatMinutes, parseTimeToMinutes, toInstant, minutesSinceLocalMidnight } from "../time";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const t = (s: string) => parseTimeToMinutes(s)!;

/** "General": 9:30 AM - 6:30 PM, 1 hour break, 15 minute grace both ways. */
const general: ShiftDef = {
  startMinutes: t("9:30 AM"), endMinutes: t("6:30 PM"), breakMinutes: 60,
  lateGraceMinutes: 15, earlyLeaveGraceMinutes: 15, isFlexible: false, flexibleMinutes: null,
};
const night: ShiftDef = { ...general, startMinutes: t("10:00 PM"), endMinutes: t("6:00 AM"), breakMinutes: 0 };

const rules: RuleDef = {
  absentIfNoRecord: false, lateAction: "MARK_LATE", lateHalfDayAfterMinutes: null, lateCountPerHalfDay: 0,
  earlyLeaveAction: "MARK_EARLY", halfDayBelowMinutes: 240, absentBelowMinutes: 0, missingPunchAction: "PRESENT",
  otEnabled: false, otPayable: false, otMinMinutes: 30, otMultiplier: 1.5, otOnOffDays: true,
};

describe("time parsing", () => {
  it("reads common formats", () => {
    expect(parseTimeToMinutes("09:30")).toBe(570);
    expect(parseTimeToMinutes("9:30 AM")).toBe(570);
    expect(parseTimeToMinutes("6:30pm")).toBe(1110);
    expect(parseTimeToMinutes("12:00 AM")).toBe(0);
    expect(parseTimeToMinutes("12:00 PM")).toBe(720);
    expect(parseTimeToMinutes("25:00")).toBeNull();
    expect(parseTimeToMinutes("9:75")).toBeNull();
  });
  it("formats and round-trips through an IST instant", () => {
    expect(formatMinutes(570)).toBe("09:30 AM");
    const date = d("2026-09-15");
    expect(minutesSinceLocalMidnight(toInstant(date, 570), date)).toBe(570);
    // 06:00 AM the next day, on the same axis as a 10 PM start
    expect(minutesSinceLocalMidnight(toInstant(date, 1440 + 360), date)).toBe(1800);
  });
});

describe("working week", () => {
  const sixDay = DEFAULT_WEEKLY_PATTERN; // Mon-Sat working, Sun off
  const saturdayAlt: WeeklyPattern = { ...DEFAULT_WEEKLY_PATTERN, sat: { mode: "ALTERNATE", offWeeks: [2, 4] } };
  const fiveDay: WeeklyPattern = { ...DEFAULT_WEEKLY_PATTERN, sat: { mode: "OFF" } };

  it("Mon-Sat working, Sunday off", () => {
    expect(isWeeklyOff(d("2026-09-20"), sixDay)).toBe(true); // Sunday
    expect(isWeeklyOff(d("2026-09-19"), sixDay)).toBe(false); // Saturday
  });
  it("Saturday can be off only in the 2nd and 4th weeks", () => {
    expect(isWeeklyOff(d("2026-09-05"), saturdayAlt)).toBe(false); // 1st Sat
    expect(isWeeklyOff(d("2026-09-12"), saturdayAlt)).toBe(true); // 2nd
    expect(isWeeklyOff(d("2026-09-19"), saturdayAlt)).toBe(false); // 3rd
    expect(isWeeklyOff(d("2026-09-26"), saturdayAlt)).toBe(true); // 4th
  });
  it("a different company can run Mon-Fri", () => {
    expect(isWeeklyOff(d("2026-09-19"), fiveDay)).toBe(true);
  });
  it("a holiday on a weekly off is just the weekly off; otherwise it is a holiday", () => {
    const hol = new Set(["2026-09-20", "2026-09-16"]);
    expect(classifyDay(d("2026-09-20"), sixDay, hol)).toBe("WEEKLY_OFF");
    expect(classifyDay(d("2026-09-16"), sixDay, hol)).toBe("HOLIDAY");
    expect(classifyDay(d("2026-09-17"), sixDay, hol)).toBe("WORKING");
  });
  it("falls back to the default for missing or malformed stored data", () => {
    expect(parsePattern(null)).toEqual(DEFAULT_WEEKLY_PATTERN);
    expect(parsePattern({ sat: { mode: "ALTERNATE", offWeeks: ["2", 9, "x"] } }).sat).toEqual({ mode: "ALTERNATE", offWeeks: [2] });
  });
});

describe("attendance engine: General shift", () => {
  const day = (i: string | null, o: string | null, extra: Partial<Parameters<typeof evaluateDay>[0]> = {}, r: Partial<RuleDef> = {}) =>
    evaluateDay(
      { dayType: "WORKING", shift: general, inMinutes: i ? t(i) : null, outMinutes: o ? t(o) : null, ...extra },
      { ...rules, ...r }
    );

  it("scheduled hours are span minus break (8h)", () => expect(scheduledMinutes(general)).toBe(480));

  it("on time, full day = Present", () => {
    const r = day("9:30 AM", "6:30 PM");
    expect(r).toMatchObject({ status: "PRESENT", workedMinutes: 480, isLate: false, lateMinutes: 0, earlyLeaveMinutes: 0 });
  });
  it("within the 15 minute grace is not late; 16 minutes is", () => {
    expect(day("9:45 AM", "6:30 PM").isLate).toBe(false);
    const late = day("9:46 AM", "6:30 PM");
    expect(late.isLate).toBe(true);
    expect(late.lateMinutes).toBe(16);
    expect(late.status).toBe("PRESENT"); // MARK_LATE only flags it
  });
  it("late can be configured to cost a half day", () => {
    expect(day("10:00 AM", "6:30 PM", {}, { lateAction: "HALF_DAY" }).status).toBe("HALF_DAY");
    // only when late enough
    expect(day("10:00 AM", "6:30 PM", {}, { lateAction: "HALF_DAY", lateHalfDayAfterMinutes: 60 }).status).toBe("PRESENT");
    expect(day("11:00 AM", "7:30 PM", {}, { lateAction: "HALF_DAY", lateHalfDayAfterMinutes: 60 }).status).toBe("HALF_DAY");
  });
  it("leaving early beyond grace is flagged", () => {
    expect(day("9:30 AM", "6:20 PM").earlyLeaveMinutes).toBe(0); // 10 min early: inside the grace
    expect(day("9:30 AM", "6:10 PM").earlyLeaveMinutes).toBe(20); // 20 min early: beyond it
    expect(day("9:30 AM", "5:30 PM").earlyLeaveMinutes).toBe(60);
    expect(day("9:30 AM", "5:30 PM", {}, { earlyLeaveAction: "HALF_DAY" }).status).toBe("HALF_DAY");
  });
  it("working under 4 hours = Half Day; under the absent limit = Absent", () => {
    expect(day("9:30 AM", "1:00 PM").status).toBe("HALF_DAY"); // 3.5h - break => 2.5h
    expect(day("9:30 AM", "12:00 PM", {}, { absentBelowMinutes: 120 }).status).toBe("ABSENT"); // 1.5h worked
  });
  it("no punch: absent only if the company enabled it, and never on a leave, holiday or weekly off", () => {
    expect(day(null, null).status).toBeNull();
    expect(day(null, null, {}, { absentIfNoRecord: true }).status).toBe("ABSENT");
    expect(day(null, null, { onLeave: true }, { absentIfNoRecord: true }).status).toBe("ON_LEAVE");
    expect(day(null, null, { dayType: "WEEKLY_OFF" }, { absentIfNoRecord: true }).status).toBe("WEEK_OFF");
    expect(day(null, null, { dayType: "HOLIDAY" }, { absentIfNoRecord: true }).status).toBe("HOLIDAY");
  });
  it("a missing out-punch is flagged and follows the company's choice", () => {
    const r = day("9:30 AM", null);
    expect(r.flags).toContain("MISSING_PUNCH");
    expect(r.status).toBe("PRESENT");
    expect(day("9:30 AM", null, {}, { missingPunchAction: "HALF_DAY" }).status).toBe("HALF_DAY");
  });
  it("overtime: 8h scheduled, 10h worked = 2h OT, but only when the policy has OT on", () => {
    expect(day("9:30 AM", "8:30 PM").overtimeMinutes).toBe(0);
    expect(day("9:30 AM", "8:30 PM", {}, { otEnabled: true }).overtimeMinutes).toBe(120);
  });
  it("overtime below the minimum threshold is ignored", () => {
    expect(day("9:30 AM", "6:50 PM", {}, { otEnabled: true }).overtimeMinutes).toBe(0); // only 20 min extra
    expect(day("9:30 AM", "7:00 PM", {}, { otEnabled: true }).overtimeMinutes).toBe(30); // exactly the threshold
  });
  it("time worked on a weekly off keeps the status but counts as overtime", () => {
    const r = day("10:00 AM", "4:00 PM", { dayType: "WEEKLY_OFF" }, { otEnabled: true });
    expect(r.status).toBe("WEEK_OFF");
    expect(r.overtimeMinutes).toBe(300); // 6h - 1h break
    expect(day("10:00 AM", "4:00 PM", { dayType: "WEEKLY_OFF" }, { otEnabled: true, otOnOffDays: false }).overtimeMinutes).toBe(0);
  });
});

describe("attendance engine: night and flexible shifts", () => {
  it("a 10 PM - 6 AM shift works across midnight", () => {
    const r = evaluateDay({ dayType: "WORKING", shift: night, inMinutes: t("10:00 PM"), outMinutes: t("6:00 AM") }, rules);
    expect(r.workedMinutes).toBe(480);
    expect(r.status).toBe("PRESENT");
    expect(r.isLate).toBe(false);
    expect(r.earlyLeaveMinutes).toBe(0);
  });
  it("night shift: leaving at 4 AM is early, arriving 10:30 PM is late", () => {
    const r = evaluateDay({ dayType: "WORKING", shift: night, inMinutes: t("10:30 PM"), outMinutes: t("4:00 AM") }, rules);
    expect(r.isLate).toBe(true);
    expect(r.earlyLeaveMinutes).toBe(120);
  });
  it("a flexible shift ignores start/end and only checks hours", () => {
    const flex: ShiftDef = { ...general, isFlexible: true, flexibleMinutes: 480, breakMinutes: 0 };
    const r = evaluateDay({ dayType: "WORKING", shift: flex, inMinutes: t("11:47 AM"), outMinutes: t("8:00 PM") }, rules);
    expect(r.isLate).toBe(false);
    expect(r.earlyLeaveMinutes).toBe(0);
    expect(r.workedMinutes).toBe(493);
  });
});

describe("loss of pay", () => {
  const base = {
    year: 2026, month: 9, pattern: DEFAULT_WEEKLY_PATTERN, holidays: new Set<string>(),
    records: new Map(), leaves: new Map(), absentIfNoRecord: false, lateCountPerHalfDay: 0, basis: "CALENDAR_DAYS" as const,
  };

  it("counts recorded absences and half days only", () => {
    const records = new Map([
      ["2026-09-01", { status: "ABSENT" as const, isLate: false }],
      ["2026-09-02", { status: "HALF_DAY" as const, isLate: false }],
      ["2026-09-03", { status: "PRESENT" as const, isLate: false }],
    ]);
    const r = computeLop({ ...base, records });
    expect(r.lopDays).toBe(1.5);
    expect(r.daysInPeriod).toBe(30);
  });
  it("does not treat missing attendance as absent unless the company says so", () => {
    expect(computeLop(base).lopDays).toBe(0);
  });
  it("absent = no attendance + no leave + not holiday + not weekly off", () => {
    const leaves = new Map([["2026-09-01", { paid: true, half: false }]]);
    const r = computeLop({ ...base, absentIfNoRecord: true, leaves, holidays: new Set(["2026-09-02"]) });
    // 30 days - 4 Sundays (6,13,20,27) - 1 holiday - 1 paid leave = 24 absent working days
    expect(r.absentDays).toBe(24);
  });
  it("unpaid (Loss of Pay) leave costs pay; paid leave does not", () => {
    const leaves = new Map([
      ["2026-09-01", { paid: false, half: false }],
      ["2026-09-02", { paid: false, half: true }],
      ["2026-09-03", { paid: true, half: false }],
    ]);
    expect(computeLop({ ...base, leaves }).lopDays).toBe(1.5);
  });
  it("N late marks cost a half day", () => {
    const records = new Map(
      ["01", "02", "03", "04", "05", "07", "08"].map((day) => [`2026-09-${day}`, { status: "PRESENT" as const, isLate: true }])
    );
    const r = computeLop({ ...base, records, lateCountPerHalfDay: 3 });
    expect(r.lateMarks).toBe(7);
    expect(r.lateHalfDays).toBe(1); // floor(7/3)=2 -> 2 x 0.5
    expect(r.lopDays).toBe(1);
  });
  it("working-days basis counts only working days in the period", () => {
    expect(computeLop({ ...base, basis: "WORKING_DAYS" }).daysInPeriod).toBe(26);
  });
  it("weekly offs never cost pay even if marked absent", () => {
    const records = new Map([["2026-09-06", { status: "ABSENT" as const, isLate: false }]]); // a Sunday
    expect(computeLop({ ...base, records }).lopDays).toBe(0);
  });
});
