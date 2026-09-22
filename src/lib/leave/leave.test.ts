import { describe, expect, it } from "vitest";
import { countLeaveDays, leaveYearOf, planLedger, sumDays, type AccrualRule, type LedgerEntryIn } from "./planner";
import { DEFAULT_WEEKLY_PATTERN } from "../attendance/calendar";
import { computeSalaryLines, validateTemplateLines, type TemplateLineDef } from "../salary/compute";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

const casual: AccrualRule = { entitlementDays: 12, accrual: "MONTHLY", carryForward: false, maxCarryForwardDays: null, maxBalance: null };
const earned: AccrualRule = { entitlementDays: 18, accrual: "MONTHLY", carryForward: true, maxCarryForwardDays: null, maxBalance: 45 };

/** Applies a plan to a ledger and returns the new balance, the way the app does. */
const apply = (entries: LedgerEntryIn[], planned: ReturnType<typeof planLedger>): LedgerEntryIn[] => [
  ...entries,
  ...planned.map((p) => ({ kind: p.kind, days: p.days, effectiveDate: p.effectiveDate, period: p.period })),
];

describe("leave year", () => {
  it("calendar year and April-March year", () => {
    expect(leaveYearOf(d("2026-03-31"), 1)).toBe(2026);
    expect(leaveYearOf(d("2026-03-31"), 4)).toBe(2025);
    expect(leaveYearOf(d("2026-04-01"), 4)).toBe(2026);
  });
});

describe("accrual planning", () => {
  it("Casual Leave 12/year accruing 1 a month (the company's own policy)", () => {
    const plan = planLedger({ joinDate: d("2023-06-01"), rule: casual, entries: [], asOf: d("2026-03-15"), startMonth: 1 });
    expect(plan.map((p) => p.period)).toEqual(["ACC:2026-01", "ACC:2026-02", "ACC:2026-03"]);
    expect(sumDays(plan)).toBe(3);
  });

  it("is idempotent: running it again adds nothing", () => {
    const first = planLedger({ joinDate: d("2023-06-01"), rule: casual, entries: [], asOf: d("2026-06-30"), startMonth: 1 });
    const ledger = apply([], first);
    expect(planLedger({ joinDate: d("2023-06-01"), rule: casual, entries: ledger, asOf: d("2026-06-30"), startMonth: 1 })).toEqual([]);
  });

  it("picks up only the new month next time", () => {
    const ledger = apply([], planLedger({ joinDate: d("2023-06-01"), rule: casual, entries: [], asOf: d("2026-05-31"), startMonth: 1 }));
    const next = planLedger({ joinDate: d("2023-06-01"), rule: casual, entries: ledger, asOf: d("2026-06-01"), startMonth: 1 });
    expect(next.map((p) => p.period)).toEqual(["ACC:2026-06"]);
  });

  it("upfront entitlement is granted once at the start of the leave year", () => {
    const rule: AccrualRule = { ...casual, accrual: "UPFRONT" };
    const plan = planLedger({ joinDate: d("2020-01-01"), rule, entries: [], asOf: d("2026-09-21"), startMonth: 1 });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ days: 12, period: "ACC:2026" });
  });

  it("a joiner mid-year is pro-rated for the months left", () => {
    const rule: AccrualRule = { ...casual, accrual: "UPFRONT" };
    const plan = planLedger({ joinDate: d("2026-07-10"), rule, entries: [], asOf: d("2026-09-21"), startMonth: 1 });
    expect(plan[0].days).toBe(6); // Jul-Dec = 6 of 12 months
  });

  it("monthly accrual starts in the joining month", () => {
    const plan = planLedger({ joinDate: d("2026-07-10"), rule: casual, entries: [], asOf: d("2026-09-21"), startMonth: 1 });
    expect(plan.map((p) => p.period)).toEqual(["ACC:2026-07", "ACC:2026-08", "ACC:2026-09"]);
  });

  it("an opening balance covers everything up to its date; accrual resumes after it", () => {
    // Rahul: opening 5 as of 1 Sep, then monthly accrual
    const opening: LedgerEntryIn[] = [{ kind: "OPENING", days: 5, effectiveDate: d("2026-09-01"), period: "OPENING" }];
    const plan = planLedger({ joinDate: d("2023-06-01"), rule: casual, entries: opening, asOf: d("2026-11-15"), startMonth: 1 });
    expect(plan.map((p) => p.period)).toEqual(["ACC:2026-10", "ACC:2026-11"]);
    expect(sumDays(apply(opening, plan))).toBe(7);
  });

  it("the ledger adds up: opening +5, accrual +1, two leaves -1 each = 4", () => {
    const ledger: LedgerEntryIn[] = [
      { kind: "OPENING", days: 5, effectiveDate: d("2026-09-01"), period: "OPENING" },
      { kind: "ACCRUAL", days: 1, effectiveDate: d("2026-10-01"), period: "ACC:2026-10" },
      { kind: "LEAVE_TAKEN", days: -1, effectiveDate: d("2026-10-05"), period: null },
      { kind: "LEAVE_TAKEN", days: -1, effectiveDate: d("2026-10-06"), period: null },
    ];
    expect(sumDays(ledger)).toBe(4);
  });

  it("no carry forward: unused balance lapses on the first day of the new year", () => {
    const ledger = apply([], planLedger({ joinDate: d("2023-01-01"), rule: casual, entries: [], asOf: d("2026-12-31"), startMonth: 1 }));
    expect(sumDays(ledger)).toBe(12);
    const next = planLedger({ joinDate: d("2023-01-01"), rule: casual, entries: ledger, asOf: d("2027-01-15"), startMonth: 1 });
    expect(next.find((p) => p.kind === "LAPSE")).toMatchObject({ days: -12, period: "LAPSE:2027" });
    expect(sumDays(apply(ledger, next))).toBe(1); // 12 lapsed, January accrued
  });

  it("carry forward keeps the balance (Earned Leave), and a cap limits accrual", () => {
    let ledger: LedgerEntryIn[] = [{ kind: "OPENING", days: 40, effectiveDate: d("2026-01-01"), period: "OPENING" }];
    ledger = apply(ledger, planLedger({ joinDate: d("2020-01-01"), rule: earned, entries: ledger, asOf: d("2026-06-30"), startMonth: 1 }));
    // 40 + 1.5/month would pass the 45 cap: it stops at 45.
    expect(sumDays(ledger)).toBe(45);
    const next = planLedger({ joinDate: d("2020-01-01"), rule: earned, entries: ledger, asOf: d("2027-01-31"), startMonth: 1 });
    expect(next.some((p) => p.kind === "LAPSE")).toBe(false); // carried forward whole
  });

  it("carry forward with a maximum lapses only the excess", () => {
    const rule: AccrualRule = { ...casual, carryForward: true, maxCarryForwardDays: 5 };
    const ledger = apply([], planLedger({ joinDate: d("2023-01-01"), rule, entries: [], asOf: d("2026-12-31"), startMonth: 1 }));
    const next = planLedger({ joinDate: d("2023-01-01"), rule, entries: ledger, asOf: d("2027-01-15"), startMonth: 1 });
    expect(next.find((p) => p.kind === "LAPSE")?.days).toBe(-7); // 12 - 5 carried
  });
});

describe("counting leave days", () => {
  const holidays = new Set(["2026-09-16"]);
  const base = { pattern: DEFAULT_WEEKLY_PATTERN, holidays, countWeeklyOffs: false, countHolidays: false, isHalfDay: false };

  it("Rahul: 15-16 Sep = 2 days (a Tuesday and a Wednesday)... unless the 16th is a holiday", () => {
    expect(countLeaveDays({ ...base, holidays: new Set(), from: d("2026-09-15"), to: d("2026-09-16") }).days).toBe(2);
    const r = countLeaveDays({ ...base, from: d("2026-09-15"), to: d("2026-09-16") });
    expect(r.days).toBe(1);
    expect(r.skippedHolidays).toBe(1);
  });
  it("skips the Sunday inside a Fri-Mon request", () => {
    const r = countLeaveDays({ ...base, holidays: new Set(), from: d("2026-09-18"), to: d("2026-09-21") });
    expect(r.days).toBe(3);
    expect(r.skippedWeeklyOffs).toBe(1);
  });
  it("a policy can count weekly offs and holidays as leave", () => {
    const r = countLeaveDays({ ...base, countWeeklyOffs: true, countHolidays: true, from: d("2026-09-15"), to: d("2026-09-20") });
    expect(r.days).toBe(6);
  });
  it("half day counts 0.5, and 0 on a non-working day", () => {
    expect(countLeaveDays({ ...base, isHalfDay: true, from: d("2026-09-15"), to: d("2026-09-15") }).days).toBe(0.5);
    expect(countLeaveDays({ ...base, isHalfDay: true, from: d("2026-09-20"), to: d("2026-09-20") }).days).toBe(0);
  });
});

describe("salary structures", () => {
  const line = (over: Partial<TemplateLineDef> & Pick<TemplateLineDef, "code" | "calcType" | "value">): TemplateLineDef => ({
    name: over.code, isBasic: false, taxable: true, includeInPf: false, includeInEsi: true, includeInPt: true, sortOrder: 0, ...over,
  });

  it("Standard: Basic 50% of CTC, HRA 40% of Basic, Special is the balance", () => {
    const r = computeSalaryLines(
      [
        line({ code: "BASIC", calcType: "PERCENT_OF_CTC", value: 50, isBasic: true, includeInPf: true, sortOrder: 1 }),
        line({ code: "HRA", calcType: "PERCENT_OF_BASIC", value: 40, sortOrder: 2 }),
        line({ code: "SPECIAL", calcType: "BALANCE", value: 0, sortOrder: 3 }),
      ],
      900000
    );
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l.monthlyAmount]));
    expect(by).toEqual({ BASIC: 37500, HRA: 15000, SPECIAL: 22500 });
    expect(r.grossMonthly).toBe(75000);
    expect(r.warnings).toEqual([]);
  });

  it("a different company can have a completely different structure", () => {
    const r = computeSalaryLines(
      [
        line({ code: "BASIC", calcType: "FIXED", value: 20000, isBasic: true, sortOrder: 1 }),
        line({ code: "CONV", calcType: "FIXED", value: 1600, sortOrder: 2 }),
        line({ code: "CAR", calcType: "PERCENT_OF_BASIC", value: 25, sortOrder: 3 }),
        line({ code: "BONUS", calcType: "FIXED", value: 3000, sortOrder: 4 }),
      ],
      600000
    );
    expect(r.lines.map((l) => l.monthlyAmount)).toEqual([20000, 1600, 5000, 3000]);
  });

  it("typed amounts override the rule, and the balance adjusts around them", () => {
    const r = computeSalaryLines(
      [
        line({ code: "BASIC", calcType: "PERCENT_OF_CTC", value: 50, isBasic: true, sortOrder: 1 }),
        line({ code: "SPECIAL", calcType: "BALANCE", value: 0, sortOrder: 2 }),
      ],
      600000,
      { BASIC: 30000 }
    );
    expect(r.lines.map((l) => l.monthlyAmount)).toEqual([30000, 20000]);
  });

  it("warns when the components exceed CTC", () => {
    const r = computeSalaryLines(
      [line({ code: "BASIC", calcType: "FIXED", value: 60000, isBasic: true, sortOrder: 1 }), line({ code: "SPECIAL", calcType: "BALANCE", value: 0, sortOrder: 2 })],
      600000
    );
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.lines[1].monthlyAmount).toBe(0);
  });

  it("validates templates", () => {
    expect(validateTemplateLines([])).toHaveLength(1);
    expect(validateTemplateLines([{ name: "A", calcType: "PERCENT_OF_BASIC", isBasic: false }])).toContain(
      "A percentage of Basic needs a Basic component in the structure"
    );
    expect(
      validateTemplateLines([
        { name: "X", calcType: "BALANCE", isBasic: false },
        { name: "Y", calcType: "BALANCE", isBasic: false },
      ])
    ).toContain("Only one component can be the balancing figure");
    expect(validateTemplateLines([{ name: "B", calcType: "BALANCE", isBasic: true }])).toContain(
      "The Basic component must be a fixed amount or a percentage of CTC"
    );
    expect(validateTemplateLines([{ name: "B", calcType: "FIXED", isBasic: true }])).toEqual([]);
  });
});
