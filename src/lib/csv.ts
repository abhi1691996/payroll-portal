/**
 * Minimal RFC 4180 CSV reader/writer. Kept dependency-free on purpose: the bulk-import
 * templates are plain CSV, which every spreadsheet tool (Excel, Sheets, LibreOffice) can
 * open and save.
 */

interface RawRow {
  /** 1-based row number in the sheet, counting blank rows. */
  line: number;
  cells: string[];
}

/** Parses CSV text into rows of cells. Handles quotes, escaped quotes, CRLF and a BOM. */
export function parseCsv(input: string): string[][] {
  return parseCsvRows(input).map((r) => r.cells);
}

function parseCsvRows(input: string): RawRow[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  // Excel in some locales saves semicolon-separated "CSV". Sniff the header line.
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";

  const rows: RawRow[] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push({ line: rows.length + 1, cells: row });
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  // Last cell/row when the file doesn't end with a newline.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push({ line: rows.length + 1, cells: row });
  }

  return rows.filter((r) => r.cells.some((c) => c.trim() !== ""));
}

export interface CsvRecord {
  /** 1-based line number in the original sheet (header is line 1). */
  line: number;
  values: Record<string, string>;
}

/** Lower-cases and strips separators so "Employee Code", "employee_code" and "employeeCode" match. */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reads CSV text into records keyed by normalized header. Blank lines are skipped but
 * line numbers still refer to the original sheet so error messages match what the user sees.
 */
export function parseCsvRecords(input: string): { headers: string[]; records: CsvRecord[] } {
  const rows = parseCsvRows(input);
  if (rows.length === 0) return { headers: [], records: [] };

  const headers = rows[0].cells.map(normalizeHeader);
  const records: CsvRecord[] = rows.slice(1).map(({ line, cells }) => {
    const values: Record<string, string> = {};
    headers.forEach((header, col) => {
      if (header) values[header] = (cells[col] ?? "").trim();
    });
    return { line, values };
  });

  return { headers, records };
}

/**
 * Serialises rows to CSV. Text cells that a spreadsheet could interpret as a formula are
 * prefixed with an apostrophe so exported employee data can't execute anything on open.
 */
export function toCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const escape = (value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined) return "";
    let str = String(value);
    if (typeof value === "string" && /^[=+@\t\r]/.test(str)) str = `'${str}`;
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n") + "\r\n";
}
