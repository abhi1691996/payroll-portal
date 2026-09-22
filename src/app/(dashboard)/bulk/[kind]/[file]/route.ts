import { NextResponse } from "next/server";
import { getContext } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { FILE_PERMISSION } from "@/lib/bulk/permissions";
import { buildAttendanceGrid, buildExport, buildSalaryTemplate } from "@/lib/bulk/exports";
import { BULK_FILE_KEYS, buildTemplateCsv } from "@/lib/bulk/templates";
import type { BulkFileKey } from "@/lib/bulk/types";

function csvResponse(filename: string, csv: string) {
  return new NextResponse("﻿" + csv, {
    headers: {
      // BOM so Excel opens UTF-8 (names with accents, ₹) correctly.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

/** GET /bulk/<kind>/template.csv  or  /bulk/<kind>/export.csv[?year=&month=] */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; file: string }> }
) {
  const ctx = await getContext();
  if (!ctx || ctx.isSuperAdmin || !ctx.companyId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { kind, file } = await params;
  if (!BULK_FILE_KEYS.includes(kind as BulkFileKey)) {
    return NextResponse.json({ error: "Unknown type" }, { status: 404 });
  }
  const key = kind as BulkFileKey;
  if (!can(ctx, FILE_PERMISSION[key], "COMPANY")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const year = Number(url.searchParams.get("year")) || undefined;
  const month = Number(url.searchParams.get("month")) || undefined;
  if (month !== undefined && (month < 1 || month > 12)) {
    return NextResponse.json({ error: "Invalid month" }, { status: 400 });
  }

  if (file === "template.csv") {
    if (key === "attendance-grid") {
      const now = new Date();
      const grid = await withTenant(ctx.companyId, (db) =>
        buildAttendanceGrid(db, year ?? now.getFullYear(), month ?? now.getMonth() + 1, false)
      );
      return csvResponse(grid.filename, grid.csv);
    }
    if (key === "salary") {
      const t = await withTenant(ctx.companyId, (db) => buildSalaryTemplate(db));
      return csvResponse(t.filename, t.csv);
    }
    const { filename, csv } = buildTemplateCsv(key);
    return csvResponse(filename, csv);
  }

  if (file === "export.csv") {
    const built = await withTenant(ctx.companyId, (db) => buildExport(db, key, { year, month }));
    if (!built) return NextResponse.json({ error: "Nothing to export" }, { status: 404 });
    return csvResponse(built.filename, built.csv);
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
