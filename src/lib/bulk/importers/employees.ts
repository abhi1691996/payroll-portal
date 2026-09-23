import { hashPassword } from "@/lib/password";
import { createEmployeeWithLogin } from "@/server/employees/service";
import { findTakenEmails } from "@/server/users/email-registry";
import { employeeSchema } from "@/lib/validations/employee";
import {
  formatDisplayDate,
  generateTempPassword,
  issueMessage,
  looksLikeScientificNotation,
  parseDate,
} from "../parse";
import type { BulkCredential, BulkImporter, BulkIssue } from "../types";

interface ValidEmployee {
  line: number;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  personalEmail: string;
  phone: string;
  panNumber: string;
  aadhaarLast4: string;
  bankAccountNumber: string;
  bankIfsc: string;
  department: string;
  designation: string;
  state: string;
  taxRegime: "OLD" | "NEW";
  dateOfJoining: Date;
  /** Blank in the sheet -> we generate one and hand it back once. */
  tempPassword: string | null;
}

export const employeesImporter: BulkImporter = {
  required: ["employeecode", "firstname", "lastname", "email", "dateofjoining", "state"],
  requiredLabels: ["employeeCode", "firstName", "lastName", "email", "dateOfJoining", "state"],
  maxRows: 500,

  async plan({ records, ctx, db }) {
    const issues: BulkIssue[] = [];
    const warnings: BulkIssue[] = [];
    const valid: ValidEmployee[] = [];

    const codes = records.map((r) => r.values.employeecode).filter(Boolean);
    const emails = records.map((r) => r.values.email).filter(Boolean);
    // Employee codes are unique per company; login emails are unique across the platform.
    const existingByCode = await db.employee.findMany({
      where: { employeeCode: { in: codes } },
      select: { employeeCode: true },
    });
    const takenCodes = new Set(existingByCode.map((e) => e.employeeCode));
    const takenEmails = await findTakenEmails(emails);

    const seenCodes = new Map<string, number>();
    const seenEmails = new Map<string, number>();

    for (const { line, values: v } of records) {
      const messages: string[] = [];

      const aadhaar = /^\d{1,3}$/.test(v.aadhaarlast4 ?? "")
        ? v.aadhaarlast4.padStart(4, "0") // spreadsheets drop leading zeros
        : (v.aadhaarlast4 ?? "");

      const parsed = employeeSchema.safeParse({
        employeeCode: v.employeecode ?? "",
        firstName: v.firstname ?? "",
        lastName: v.lastname ?? "",
        email: v.email ?? "",
        personalEmail: v.personalemail ?? "",
        phone: v.phone ?? "",
        panNumber: (v.pannumber ?? v.pan ?? "").toUpperCase(),
        aadhaarLast4: aadhaar,
        bankAccountNumber: v.bankaccountnumber ?? "",
        bankIfsc: (v.bankifsc ?? "").toUpperCase(),
        department: v.department ?? "",
        designation: v.designation ?? "",
        dateOfJoining: v.dateofjoining ?? "",
        state: v.state ?? "",
        taxRegime: (v.taxregime || "NEW").toUpperCase(),
      });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) messages.push(issueMessage(issue.path, issue.message));
      }

      const joined = parseDate(v.dateofjoining ?? "");
      if (v.dateofjoining && !joined) {
        messages.push("dateOfJoining: use a date like 2025-04-01 or 01/04/2025");
      }

      for (const field of ["bankaccountnumber", "phone"] as const) {
        if (v[field] && looksLikeScientificNotation(v[field])) {
          messages.push(
            `${field === "phone" ? "phone" : "bankAccountNumber"}: looks like Excel scientific notation (${v[field]}). Format the column as Text and re-enter it`
          );
        }
      }

      const tempPassword = v.temppassword ? v.temppassword : null;
      if (tempPassword && tempPassword.length < 8) {
        messages.push("tempPassword: must be at least 8 characters (or leave blank to auto-generate)");
      }

      const code = v.employeecode ?? "";
      const email = (v.email ?? "").toLowerCase();
      if (code && takenCodes.has(code)) messages.push(`employeeCode ${code} already exists`);
      if (email && takenEmails.has(email)) messages.push(`email ${v.email} is already registered`);
      if (code && seenCodes.has(code)) {
        messages.push(`employeeCode ${code} is repeated (first seen on line ${seenCodes.get(code)})`);
      }
      if (email && seenEmails.has(email)) {
        messages.push(`email ${v.email} is repeated (first seen on line ${seenEmails.get(email)})`);
      }
      if (code && !seenCodes.has(code)) seenCodes.set(code, line);
      if (email && !seenEmails.has(email)) seenEmails.set(email, line);

      if (messages.length > 0 || !parsed.success || !joined) {
        issues.push({ line, messages });
        continue;
      }

      const d = parsed.data;
      valid.push({
        line,
        employeeCode: d.employeeCode,
        firstName: d.firstName,
        lastName: d.lastName ?? "",
        email: d.email,
        personalEmail: d.personalEmail ?? "",
        phone: d.phone ?? "",
        panNumber: d.panNumber ?? "",
        aadhaarLast4: d.aadhaarLast4 ?? "",
        bankAccountNumber: d.bankAccountNumber ?? "",
        bankIfsc: d.bankIfsc ?? "",
        department: d.department ?? "",
        designation: d.designation ?? "",
        state: d.state,
        taxRegime: d.taxRegime,
        dateOfJoining: joined,
        tempPassword,
      });

      if (!d.panNumber) warnings.push({ line, messages: ["No PAN — TDS may be deducted at a higher rate"] });
    }

    const previewRows = valid.slice(0, 8).map((e) => [
      e.employeeCode,
      `${e.firstName} ${e.lastName}`,
      e.email,
      e.department || "—",
      e.state,
      formatDisplayDate(e.dateOfJoining),
    ]);

    return {
      total: records.length,
      valid: valid.length,
      issues,
      warnings,
      preview: {
        columns: ["Code", "Name", "Login email", "Department", "State", "Joined"],
        rows: previewRows,
        truncated: valid.length > previewRows.length,
      },
      summary: `${valid.length} new employee login${valid.length === 1 ? "" : "s"} will be created`,
      async commit() {
        const credentials: BulkCredential[] = [];

        // Hash sequentially: bcrypt is CPU-bound, so parallelism gains nothing. Everything runs in
        // the caller's transaction, so a failure part-way creates no employees at all.
        for (const e of valid) {
          const password = e.tempPassword ?? generateTempPassword();
          if (!e.tempPassword) {
            credentials.push({
              employeeCode: e.employeeCode,
              name: `${e.firstName} ${e.lastName}`,
              email: e.email,
              tempPassword: password,
            });
          }
          await createEmployeeWithLogin(db, ctx.actor, {
            ...e,
            passwordHash: await hashPassword(password),
          });
        }

        return { imported: valid.length, credentials };
      },
    };
  },
};
