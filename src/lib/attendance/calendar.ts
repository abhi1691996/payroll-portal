/** The company's working week and holidays: which days are working days, weekly offs or holidays. */

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/**
 * WORKING   - always a working day
 * OFF       - always a weekly off
 * ALTERNATE - off only in the listed occurrences within the month (e.g. 2nd and 4th Saturday), working otherwise
 */
export type DayMode = "WORKING" | "OFF" | "ALTERNATE";
export interface DayRule {
  mode: DayMode;
  /** For ALTERNATE: which occurrences (1-5) of this weekday in the month are off. */
  offWeeks?: number[];
}
export type WeeklyPattern = Record<WeekdayKey, DayRule>;

export const DEFAULT_WEEKLY_PATTERN: WeeklyPattern = {
  mon: { mode: "WORKING" }, tue: { mode: "WORKING" }, wed: { mode: "WORKING" }, thu: { mode: "WORKING" },
  fri: { mode: "WORKING" }, sat: { mode: "WORKING" }, sun: { mode: "OFF" },
};

/** Reads the stored JSON defensively; anything missing or malformed falls back to the default. */
export function parsePattern(json: unknown): WeeklyPattern {
  const out: WeeklyPattern = { ...DEFAULT_WEEKLY_PATTERN };
  if (!json || typeof json !== "object") return out;
  for (const key of WEEKDAYS) {
    const raw = (json as Record<string, unknown>)[key] as { mode?: string; offWeeks?: unknown } | undefined;
    if (!raw || (raw.mode !== "WORKING" && raw.mode !== "OFF" && raw.mode !== "ALTERNATE")) continue;
    out[key] = {
      mode: raw.mode,
      ...(raw.mode === "ALTERNATE"
        ? { offWeeks: (Array.isArray(raw.offWeeks) ? raw.offWeeks : []).map(Number).filter((n) => n >= 1 && n <= 5) }
        : {}),
    };
  }
  return out;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function weekdayKey(date: Date): WeekdayKey {
  return WEEKDAYS[date.getUTCDay()];
}

/** 1 for the first Saturday of the month, 2 for the second, ... (date is a UTC-midnight date). */
export function occurrenceInMonth(date: Date): number {
  return Math.ceil(date.getUTCDate() / 7);
}

export type DayType = "WORKING" | "WEEKLY_OFF" | "HOLIDAY";

export function isWeeklyOff(date: Date, pattern: WeeklyPattern): boolean {
  const rule = pattern[weekdayKey(date)];
  if (rule.mode === "OFF") return true;
  if (rule.mode === "ALTERNATE") return (rule.offWeeks ?? []).includes(occurrenceInMonth(date));
  return false;
}

/** A holiday that falls on a weekly off is simply the weekly off. */
export function classifyDay(date: Date, pattern: WeeklyPattern, holidays: ReadonlySet<string>): DayType {
  if (isWeeklyOff(date, pattern)) return "WEEKLY_OFF";
  if (holidays.has(isoDate(date))) return "HOLIDAY";
  return "WORKING";
}

/** Every date (UTC midnight) from `from` to `to` inclusive. */
export function eachDate(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) out.push(new Date(t));
  return out;
}

export function describePattern(pattern: WeeklyPattern): string {
  const label = (k: WeekdayKey) => {
    const r = pattern[k];
    return r.mode === "WORKING" ? "working" : r.mode === "OFF" ? "off" : `off on ${(r.offWeeks ?? []).join(", ")}`;
  };
  return (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const)
    .map((k) => `${WEEKDAY_LABELS[k].slice(0, 3)} ${label(k)}`)
    .join(" · ");
}
