/**
 * Time helpers. Punch times are stored as real instants; the company time zone is India (IST, UTC+5:30,
 * no daylight saving), so local "minutes since midnight" convert with a fixed offset.
 */
export const IST_OFFSET_MINUTES = 330;
const MS = 60_000;

/** Accepts "09:30", "9:30", "9:30 AM", "6:30pm", "18:30". Returns minutes after midnight, or null. */
export function parseTimeToMinutes(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return h * 60 + min;
}

/** 570 -> "09:30 AM". */
export function formatMinutes(total: number): string {
  const t = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** 570 -> "09:30" (for <input type="time">). */
export function toHHMM(total: number): string {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * The instant for `minutes` after LOCAL midnight of `date` (a UTC-midnight date). Minutes >= 1440 land on
 * the next day, which is how a night-shift "out" time is represented.
 */
export function toInstant(date: Date, minutes: number): Date {
  return new Date(date.getTime() + (minutes - IST_OFFSET_MINUTES) * MS);
}

/** Minutes after the local midnight of `date` at which `instant` falls (may be >= 1440). */
export function minutesSinceLocalMidnight(instant: Date, date: Date): number {
  return Math.round((instant.getTime() - date.getTime()) / MS) + IST_OFFSET_MINUTES;
}

export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}
