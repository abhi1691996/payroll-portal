import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { getContext } from "@/server/rbac/guard";
import { can, employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { PayslipDocument } from "@/lib/pdf/payslip-document";
import type { PayrollBreakdown } from "@/lib/payroll-calculations";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!can(ctx, "payslip.read", "OWN")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Company-scoped and limited to the caller's scope (employees: only their own payslips).
  const { payslip, company } = await withTenant(ctx.companyId, async (db) => ({
    payslip: await db.payslip.findFirst({
      where: { id, employee: employeeScopeWhere(ctx, "payslip.read") },
      include: { employee: true, payrollRun: true },
    }),
    company: await db.company.findFirst(),
  }));
  if (!payslip) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const pdfBuffer = await renderToBuffer(
    <PayslipDocument
      companyName={company?.name ?? "Company"}
      companyAddress={company?.address ?? ""}
      employeeName={`${payslip.employee.firstName} ${payslip.employee.lastName}`}
      employeeCode={payslip.employee.employeeCode}
      period={monthLabel(payslip.payrollRun.year, payslip.payrollRun.month)}
      breakdown={payslip.breakdown as unknown as PayrollBreakdown}
    />
  );

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="payslip-${payslip.employee.employeeCode}-${payslip.payrollRun.year}-${payslip.payrollRun.month}.pdf"`,
    },
  });
}
