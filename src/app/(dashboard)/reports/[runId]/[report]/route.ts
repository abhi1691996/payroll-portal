import { NextResponse } from "next/server";
import { getContext } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import type { PayrollBreakdown } from "@/lib/payroll-calculations";
import {
  buildEsiReportCsv,
  buildPfReportCsv,
  buildProfessionalTaxReportCsv,
  buildTdsReportCsv,
  type PayslipForReport,
} from "@/lib/reports";

const BUILDERS: Record<string, (payslips: PayslipForReport[]) => string> = {
  "pf.csv": buildPfReportCsv,
  "esi.csv": buildEsiReportCsv,
  "pt.csv": buildProfessionalTaxReportCsv,
  "tds.csv": buildTdsReportCsv,
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; report: string }> }
) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!can(ctx, "report.read", "COMPANY")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId, report } = await params;
  const builder = BUILDERS[report];
  if (!builder) {
    return NextResponse.json({ error: "Unknown report" }, { status: 404 });
  }

  // Scoped to the caller's company: another company's run id simply returns no payslips.
  const payslips = await withTenant(ctx.companyId, (db) =>
    db.payslip.findMany({
      where: { payrollRunId: runId },
      include: { employee: true },
      orderBy: { employee: { firstName: "asc" } },
    })
  );

  const csv = builder(
    payslips.map((p) => ({
      employee: p.employee,
      breakdown: p.breakdown as unknown as PayrollBreakdown,
    }))
  );

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${report.replace(".csv", "")}-${runId}.csv"`,
    },
  });
}
