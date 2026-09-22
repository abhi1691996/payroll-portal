import { describe, expect, it } from "vitest";
import {
  formatIsoDate,
  generateTempPassword,
  looksLikeScientificNotation,
  parseAmount,
  parseAttendanceStatus,
  parseBool,
  parseDate,
} from "./parse";

describe("parseDate", () => {
  const iso = (s: string) => {
    const d = parseDate(s);
    return d ? formatIsoDate(d) : null;
  };

  it("reads ISO and day-first formats as UTC midnight", () => {
    expect(iso("2025-04-01")).toBe("2025-04-01");
    expect(iso("01/04/2025")).toBe("2025-04-01");
    expect(iso("1-4-2025")).toBe("2025-04-01");
    expect(iso("01.04.2025")).toBe("2025-04-01");
    expect(parseDate("2025-04-01")!.getUTCHours()).toBe(0);
  });

  it("treats numeric slashed dates as DD/MM (Indian convention), not MM/DD", () => {
    expect(iso("03/04/2025")).toBe("2025-04-03");
  });

  it("reads month names", () => {
    expect(iso("01-Apr-2025")).toBe("2025-04-01");
    expect(iso("1 April 2025")).toBe("2025-04-01");
  });

  it("rejects impossible dates instead of rolling over", () => {
    expect(parseDate("31/02/2025")).toBeNull();
    expect(parseDate("2025-13-01")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("accepts a real leap day only in leap years", () => {
    expect(iso("29/02/2024")).toBe("2024-02-29");
    expect(parseDate("29/02/2025")).toBeNull();
  });
});

describe("parseAmount", () => {
  it("strips rupee signs and Indian digit grouping", () => {
    expect(parseAmount("₹1,20,000.50")).toBe(120000.5);
    expect(parseAmount("30000")).toBe(30000);
    expect(parseAmount("Rs. 500")).toBe(500);
  });

  it("rejects text, negatives and empty values", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("-100")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("12.3.4")).toBeNull();
  });
});

describe("parseBool", () => {
  it("understands common yes/no spellings", () => {
    expect(parseBool("YES")).toBe(true);
    expect(parseBool("y")).toBe(true);
    expect(parseBool("No")).toBe(false);
    expect(parseBool("0")).toBe(false);
    expect(parseBool("maybe")).toBeNull();
  });
});

describe("parseAttendanceStatus", () => {
  it("accepts short codes and full names, case/space/underscore-insensitive", () => {
    expect(parseAttendanceStatus("P")).toBe("PRESENT");
    expect(parseAttendanceStatus("a")).toBe("ABSENT");
    expect(parseAttendanceStatus("HD")).toBe("HALF_DAY");
    expect(parseAttendanceStatus("Half Day")).toBe("HALF_DAY");
    expect(parseAttendanceStatus("HALF_DAY")).toBe("HALF_DAY");
    expect(parseAttendanceStatus("WO")).toBe("WEEK_OFF");
    expect(parseAttendanceStatus("HOL")).toBe("HOLIDAY");
    expect(parseAttendanceStatus("L")).toBe("ON_LEAVE");
  });

  it("does not guess ambiguous or unknown codes", () => {
    expect(parseAttendanceStatus("H")).toBeNull();
    expect(parseAttendanceStatus("??")).toBeNull();
    expect(parseAttendanceStatus("")).toBeNull();
  });
});

describe("looksLikeScientificNotation", () => {
  it("flags spreadsheet-mangled long numbers", () => {
    expect(looksLikeScientificNotation("1.23457E+15")).toBe(true);
    expect(looksLikeScientificNotation("123456789012")).toBe(false);
  });
});

describe("generateTempPassword", () => {
  it("generates passwords of the requested length without look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword(12);
      expect(p).toHaveLength(12);
      expect(p).not.toMatch(/[0OIl1]/);
    }
  });

  it("does not repeat", () => {
    expect(generateTempPassword()).not.toBe(generateTempPassword());
  });
});
