import { requirePermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { monthLabel } from "@/lib/dates";
import { Icon } from "@/components/icons";
import { Alert, Card, CardHeader, EmptyRow, LinkButton, PageHeader, StatusBadge, Table, TableCard, Td, Th, Tr, buttonClass } from "@/components/ui";

const REPORT_TYPES = [
  { key: "pf", label: "PF" },
  { key: "esi", label: "ESI" },
  { key: "pt", label: "Prof. Tax" },
  { key: "tds", label: "TDS" },
];

export default async function ReportsPage() {
  const ctx = await requirePermission("report.read", "COMPANY");
  const runs = await withTenant(ctx.companyId, (db) =>
    db.payrollRun.findMany({
      where: { status: { in: ["PROCESSED", "FINALIZED"] } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    })
  );

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Statutory reports"
        description="CSV summaries per payroll run, ready for your CA or accountant."
      />

      <div className="mb-6">
        <Alert tone="info">
          Export these to file with EPFO, ESIC, the state Professional Tax authority and the Income Tax
          department. Nothing here is submitted anywhere automatically.
        </Alert>
      </div>

      <Card className="mb-8">
        <CardHeader
          title="Employee master sheet"
          description="Every employee (any status) with their personal details and current salary, in one Excel workbook — a second sheet breaks each salary down into its components."
        />
        <LinkButton href="/reports/mastersheet" icon="download" download>
          Download master sheet (.xlsx)
        </LinkButton>
      </Card>

      <TableCard>
        <Table>
          <thead>
            <tr>
              <Th>Period</Th>
              <Th>Status</Th>
              {REPORT_TYPES.map((rt) => (
                <Th key={rt.key}>{rt.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <Tr key={run.id}>
                <Td className="whitespace-nowrap font-medium">{monthLabel(run.year, run.month)}</Td>
                <Td>
                  <StatusBadge status={run.status} />
                </Td>
                {REPORT_TYPES.map((rt) => (
                  <Td key={rt.key}>
                    <a
                      href={`/reports/${run.id}/${rt.key}.csv`}
                      aria-label={`Download ${rt.label} report for ${monthLabel(run.year, run.month)}`}
                      className={buttonClass("secondary", "sm")}
                    >
                      <Icon name="download" className="size-3.5" />
                      CSV
                    </a>
                  </Td>
                ))}
              </Tr>
            ))}
            {runs.length === 0 && <EmptyRow colSpan={6}>No processed payroll runs yet.</EmptyRow>}
          </tbody>
        </Table>
      </TableCard>
    </div>
  );
}
