export function daysInMonth(year: number, month: number): number {
  // month is 1-indexed (1 = January); day 0 of next month = last day of this month.
  return new Date(year, month, 0).getDate();
}

export function monthLabel(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdayLabel(year: number, month: number, day: number): string {
  return WEEKDAY_LABELS[new Date(year, month - 1, day).getDay()];
}
