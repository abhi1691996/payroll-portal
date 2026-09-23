import type { AttendanceStatus } from "@prisma/client";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function utcDate(year: number, month: number, day: number): Date | null {
  if (year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow like 31/02 which Date silently rolls into March.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

/**
 * Parses the date formats people actually type into spreadsheets, returning UTC midnight
 * (the same convention the rest of the app uses for pure dates):
 *   2025-04-01, 2025/04/01, 01/04/2025, 1-4-2025, 01.04.2025, 01-Apr-2025, 1 April 2025
 * Numeric day-first dates are read as DD/MM/YYYY (Indian convention).
 */
export function parseDate(raw: string): Date | null {
  const value = raw.trim();
  if (!value) return null;

  let m = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return utcDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return utcDate(Number(m[3]), Number(m[2]), Number(m[1]));

  m = value.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{4})$/);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return utcDate(Number(m[3]), month, Number(m[1]));
  }

  return null;
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Display format used in previews and messages, e.g. 01 Apr 2025. */
export function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Parses "₹ 1,20,000.50" style amounts. Returns null for anything that isn't a plain non-negative number. */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]|^rs\.?/gi, "");
  if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function parseBool(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (["yes", "y", "true", "1", "enrolled", "opted"].includes(value)) return true;
  if (["no", "n", "false", "0", "exempt", "opted out"].includes(value)) return false;
  return null;
}

/** Spreadsheets turn long digit strings into 1.23457E+15. Detect it so we don't silently store garbage. */
export function looksLikeScientificNotation(value: string): boolean {
  return /^\d(\.\d+)?e\+?\d+$/i.test(value.trim());
}

const ATTENDANCE_CODES: Record<string, AttendanceStatus> = {
  present: "PRESENT",
  p: "PRESENT",
  absent: "ABSENT",
  a: "ABSENT",
  halfday: "HALF_DAY",
  half: "HALF_DAY",
  hd: "HALF_DAY",
  holiday: "HOLIDAY",
  hol: "HOLIDAY",
  weekoff: "WEEK_OFF",
  wo: "WEEK_OFF",
  weeklyoff: "WEEK_OFF",
  onleave: "ON_LEAVE",
  leave: "ON_LEAVE",
  l: "ON_LEAVE",
  wfh: "WFH",
  workfromhome: "WFH",
  ol: "ON_LEAVE",
};

/** Accepts full names (PRESENT, Half Day, WEEK_OFF) and short codes (P, A, HD, HOL, WO, L, WFH). */
export function parseAttendanceStatus(raw: string): AttendanceStatus | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  return ATTENDANCE_CODES[key] ?? null;
}

/** Short code used in the monthly attendance grid template/export. */
export const ATTENDANCE_SHORT_CODE: Record<AttendanceStatus, string> = {
  PRESENT: "P",
  ABSENT: "A",
  HALF_DAY: "HD",
  HOLIDAY: "HOL",
  WEEK_OFF: "WO",
  ON_LEAVE: "L",
  WFH: "WFH",
};

/** Generates a readable temporary password, avoiding look-alike characters (0/O, 1/l/I). */
export function generateTempPassword(length = 12): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Zod issue -> "field: message" so a user knows which column to fix. */
export function issueMessage(path: PropertyKey[], message: string): string {
  const field = path.map(String).join(".");
  return field ? `${field}: ${message}` : message;
}
