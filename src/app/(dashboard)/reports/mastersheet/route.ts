import { NextResponse } from "next/server";
import { getContext } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { readLines } from "@/server/salary/service";
import { buildEmployeeMasterSheet, type MasterSheetEmployee } from "@/server/reports/mastersheet";

export async function GET() {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!can(ctx, "report.read", "COMPANY")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await withTenant(ctx.companyId, async (db) => {
    const employees = await db.employee.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { firstName: "asc" },
    });
    const managerNames = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

    const now = new Date();
    const salaries = await db.employeeSalary.findMany({
      where: { effectiveFrom: { lte: now } },
      orderBy: { effectiveFrom: "desc" },
    });
    const currentSalaryByEmployee = new Map<string, (typeof salaries)[number]>();
    for (const s of salaries) {
      if (!currentSalaryByEmployee.has(s.employeeId)) currentSalaryByEmployee.set(s.employeeId, s);
    }

    return employees.map((e): MasterSheetEmployee => {
      const salary = currentSalaryByEmployee.get(e.id);
      return {
        employeeCode: e.employeeCode,
        firstName: e.firstName,
        lastName: e.lastName,
        gender: e.gender,
        dateOfBirth: e.dateOfBirth,
        maritalStatus: e.maritalStatus,
        bloodGroup: e.bloodGroup,
        emergencyContactName: e.emergencyContactName,
        emergencyContactPhone: e.emergencyContactPhone,
        category: e.category,
        department: e.department,
        designation: e.designation,
        managerName: e.managerId ? (managerNames.get(e.managerId) ?? null) : null,
        dateOfJoining: e.dateOfJoining,
        dateOfExit: e.dateOfExit,
        status: e.status,
        state: e.state,
        personalEmail: e.personalEmail,
        phone: e.phone,
        loginEmail: e.user?.email ?? null,
        panNumber: e.panNumber,
        aadhaarLast4: e.aadhaarLast4,
        bankAccountNumber: e.bankAccountNumber,
        bankIfsc: e.bankIfsc,
        taxRegime: e.taxRegime,
        currentSalary: salary
          ? {
              ctcAnnual: Number(salary.ctcAnnual),
              grossMonthly: Number(salary.grossMonthly),
              employerPfOptIn: salary.employerPfOptIn,
              effectiveFrom: salary.effectiveFrom,
              lines: readLines(salary.lines),
            }
          : null,
      };
    });
  });

  const buf = await buildEmployeeMasterSheet(rows);

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="employee-master-sheet-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
