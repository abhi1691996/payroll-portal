import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords, toCsv } from "./csv";

describe("parseCsv", () => {
  it("parses simple rows and ignores a trailing newline", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted commas, escaped quotes and embedded newlines", () => {
    const rows = parseCsv('name,note\n"Doe, Jane","said ""hi"""\n"Multi\nline",x');
    expect(rows[1]).toEqual(["Doe, Jane", 'said "hi"']);
    expect(rows[2]).toEqual(["Multi\nline", "x"]);
  });

  it("handles CRLF and a UTF-8 BOM (Excel's default)", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("detects semicolon-delimited files", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops fully blank lines", () => {
    expect(parseCsv("a,b\n,\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsvRecords", () => {
  it("normalizes headers so naming styles all match", () => {
    const { headers } = parseCsvRecords("Employee Code,first_name,dateOfJoining\nE1,A,2025-01-01");
    expect(headers).toEqual(["employeecode", "firstname", "dateofjoining"]);
  });

  it("reports line numbers relative to the original sheet, counting skipped blanks", () => {
    const { records } = parseCsvRecords("code\nA\n\nB");
    // Row 3 is blank and skipped, but B must still be reported as row 4 — the number the
    // user sees in their spreadsheet.
    expect(records.map((r) => r.line)).toEqual([2, 4]);
    expect(records[0].values.code).toBe("A");
  });

  it("trims cells and tolerates short rows", () => {
    const { records } = parseCsvRecords("a,b,c\n  x  ,y");
    expect(records[0].values).toEqual({ a: "x", b: "y", c: "" });
  });
});

describe("toCsv", () => {
  it("quotes cells containing commas, quotes or newlines", () => {
    expect(toCsv(["a"], [['he said "x", ok']])).toBe('a\r\n"he said ""x"", ok"\r\n');
  });

  it("neutralises spreadsheet formula injection in text cells but leaves numbers alone", () => {
    const csv = toCsv(["a", "b"], [["=HYPERLINK(\"evil\")", -5]]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain(",-5");
  });

  it("writes null/undefined as empty", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,\r\n");
  });

  it("round-trips through the parser", () => {
    const rows = [["EMP1", 'Name, "Q"', "x\ny"]];
    const parsed = parseCsv(toCsv(["c", "n", "m"], rows));
    expect(parsed[1]).toEqual(["EMP1", 'Name, "Q"', "x\ny"]);
  });
});
