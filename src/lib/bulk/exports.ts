import type { AttendanceStatus } from "@prisma/client";
import type { TenantDb } from "@/server/tenancy/db";
import { SEPARATED_STATUSES } from "@/server/employees/lifecycle";
import { daysInMonth } from "@/lib/dates";
import { toCsv } from "../csv";
import { ATTENDANCE_SHORT_CODE, formatIsoDate } from "./parse";
import { TEMPLATES } from "./templates";
import { readLines } from "@/server/salary/service";
import type { BulkFileKey } from "./types";

export interface BulkFile {
  filename: string;
  csv: string;
}

/**
 * Monthly attendance grid, prefilled with every active employee. `withData` fills in
 * whatever is already recorded (export); without it the cells are blank (template).
 */
export async function buildAttendanceGrid(
  db: TenantDb,
  year: number,
  month: number,
  withData: boolean
): Promise<BulkFile> {
  const total = daysInMonth(year, month);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  const [employees, records] = await Promise.all([
    db.employee.findMany({
      where: { status: { notIn: SEPARATED_STATUSES } },
      orderBy: { employeeCode: "asc" },
    }),
    withData
      ? db.attendanceRecord.findMany({ where: { date: { gte: start, lt: end } } })
      : Promise.resolve([]),
  ]);

  const statusByEmployeeDay = new Map<string, Map<number, AttendanceStatus>>();
  for (const r of records) {
    const days = statusByEmployeeDay.get(r.employeeId) ?? new Map<number, AttendanceStatus>();
    days.set(r.date.getUTCDate(), r.status);
    statusByEmployeeDay.set(r.employeeId, days);
  }

  const days = Array.from({ length: total }, (_, i) => i + 1);
  const rows = employees.map((e) => {
    const byDay = statusByEmployeeDay.get(e.id) ?? new Map<number, AttendanceStatus>();
    return [
      e.employeeCode,
      `${e.firstName} ${e.lastName}`,
      ...days.map((d) => (byDay.has(d) ? ATTENDANCE_SHORT_CODE[byDay.get(d)!] : "")),
    ];
  });

  const label = `${year}-${String(month).padStart(2, "0")}`;
  return {
    filename: `attendance-grid-${label}${withData ? "" : "-template"}`,
    csv: toCsv(["employeeCode", "name", ...days.map(String)], rows),
  };
}

/** Current data in exactly the shape the importer reads, so it can be edited and re-uploaded. */
export async function buildExport(
  db: TenantDb,
  key: BulkFileKey,
  params: { year?: number; month?: number }
): Promise<BulkFile | null> {
  switch (key) {
    case "employees": {
      const rows = await db.employee.findMany({ orderBy: { employeeCode: "asc" }, include: { user: true } });
      return {
        filename: "employees",
        csv: toCsv(
          TEMPLATES.employees.headers,
          rows.map((e) => [
            e.employeeCode,
            e.firstName,
            e.lastName,
            e.user?.email ?? "",
            formatIsoDate(e.dateOfJoining),
            e.state,
            e.department,
            e.designation,
            e.phone,
            e.personalEmail,
            e.panNumber,
            e.aadhaarLast4,
            e.bankAccountNumber,
            e.bankIfsc,
            e.taxRegime,
            "", // passwords are never exported
          ])
        ),
      };
    }

    case "salary": {
      const [rows, components] = await Promise.all([
        db.employee.findMany({
          orderBy: { employeeCode: "asc" },
          include: { salaries: { orderBy: { effectiveFrom: "desc" }, take: 1, include: { template: { select: { name: true } } } } },
        }),
        db.salaryComponent.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
      ]);
      return {
        filename: "salaries",
        csv: toCsv(
          ["employeeCode", "effectiveFrom", "ctcAnnual", "structure", "employerPfOptIn", "taxRegime", ...components.map((c) => c.code)],
          rows.flatMap((e) => {
            const s = e.salaries[0];
            if (!s) return [];
            const amounts = new Map(readLines(s.lines).map((l) => [l.code, l.monthlyAmount]));
            return [[
              e.employeeCode, formatIsoDate(s.effectiveFrom), Number(s.ctcAnnual), s.template?.name ?? "", s.employerPfOptIn ? "YES" : "NO", e.taxRegime,
              ...components.map((c) => amounts.get(c.code) ?? ""),
            ]];
          })
        ),
      };
    }

    case "attendance-grid": {
      const now = new Date();
      return buildAttendanceGrid(db, params.year ?? now.getFullYear(), params.month ?? now.getMonth() + 1, true);
    }

    case "attendance": {
      const now = new Date();
      const year = params.year ?? now.getFullYear();
      const month = params.month ?? now.getMonth() + 1;
      const records = await db.attendanceRecord.findMany({
        where: { date: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) } },
        include: { employee: { select: { employeeCode: true } } },
        orderBy: [{ employee: { employeeCode: "asc" } }, { date: "asc" }],
      });
      return {
        filename: `attendance-${year}-${String(month).padStart(2, "0")}`,
        csv: toCsv(
          TEMPLATES.attendance.headers,
          records.map((r) => [r.employee.employeeCode, formatIsoDate(r.date), ATTENDANCE_SHORT_CODE[r.status]])
        ),
      };
    }

    case "leave-requests": {
      const rows = await db.leaveRequest.findMany({
        include: { employee: { select: { employeeCode: true } }, leaveType: true },
        orderBy: { startDate: "desc" },
      });
      return {
        filename: "leave-requests",
        csv: toCsv(
          TEMPLATES["leave-requests"].headers,
          rows.map((r) => [
            r.employee.employeeCode,
            r.leaveType.name,
            formatIsoDate(r.startDate),
            formatIsoDate(r.endDate),
            r.status,
            r.reason,
          ])
        ),
      };
    }

    case "leave-balances": {
      const [sums, employees, types] = await Promise.all([
        db.leaveLedger.groupBy({ by: ["employeeId", "leaveTypeId"], _sum: { days: true } }),
        db.employee.findMany({ select: { id: true, employeeCode: true }, orderBy: { employeeCode: "asc" } }),
        db.leaveType.findMany({ select: { id: true, name: true } }),
      ]);
      const code = new Map(employees.map((e) => [e.id, e.employeeCode]));
      const typeName = new Map(types.map((t) => [t.id, t.name]));
      return {
        filename: "leave-balances",
        csv: toCsv(
          TEMPLATES["leave-balances"].headers,
          sums
            .map((x) => [code.get(x.employeeId) ?? "", typeName.get(x.leaveTypeId) ?? "", Number(x._sum.days ?? 0), ""])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])))
        ),
      };
    }
  }
}

/** Salary template with one column per component this company has defined. */
export async function buildSalaryTemplate(db: TenantDb): Promise<BulkFile> {
  const [components, templates] = await Promise.all([
    db.salaryComponent.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
    db.salaryTemplate.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { name: true } }),
  ]);
  const structure = templates[0]?.name ?? "Standard";
  const headers = ["employeeCode", "effectiveFrom", "ctcAnnual", "structure", "employerPfOptIn", "taxRegime", ...components.map((c) => c.code)];
  const blanks = components.map(() => "");
  return {
    filename: "salaries-template",
    csv: toCsv(headers, [
      ["EMP101", "2025-04-01", 600000, structure, "YES", "NEW", ...blanks],
      ["EMP102", "2025-04-01", 420000, structure, "YES", "NEW", ...blanks],
    ]),
  };
}
