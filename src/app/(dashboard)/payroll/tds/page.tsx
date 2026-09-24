import { requirePermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { fmtDate, inr } from "@/lib/format";
import { fyLabel, recentFinancialYears } from "@/lib/fy";
import { previewTdsComputation } from "@/server/tds/service";
import { getStatutoryConfigFor } from "@/lib/statutory-config";
import { ROSTER_STATUSES } from "@/server/employees/lifecycle";
import { TdsComputeForm } from "@/components/tds-compute-form";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  cx,
  EmptyRow,
  Field,
  PageHeader,
  StatusBadge,
  Table,
  TableCard,
  Td,
  Th,
  Tr,
  buttonClass,
  inputAuto,
} from "@/components/ui";
import { approveTdsAction, withdrawTdsAction } from "./actions";

export default async function TdsComputationPage({
  searchParams,
}: {
  searchParams: Promise<{ employeeId?: string; fy?: string; regime?: string }>;
}) {
  const ctx = await requirePermission("tds.manage", "COMPANY");
  const sp = await searchParams;
  const fyOptions = recentFinancialYears();
  const financialYear = Number(sp.fy) || fyOptions[1]; // fyOptions is [next, current, current-1, ...]; default to "current"
  const taxRegime = sp.regime === "OLD" ? "OLD" : "NEW";

  const data = await withTenant(ctx.companyId, async (db) => {
    const employees = await db.employee.findMany({
      where: { status: { in: ROSTER_STATUSES } },
      orderBy: { firstName: "asc" },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, taxRegime: true },
    });
    const employeeId = sp.employeeId || employees[0]?.id;
    const employee = employees.find((e) => e.id === employeeId);

    if (!employee) return { employees, employee: null };

    const [preview, history, config] = await Promise.all([
      previewTdsComputation(db, { employeeId, financialYear, taxRegime }),
      db.tdsComputation.findMany({ where: { employeeId, financialYear }, orderBy: { version: "desc" } }),
      getStatutoryConfigFor(db, new Date()),
    ]);
    const nextVersion = (history[0]?.version ?? 0) + 1;

    return { employees, employee, preview, history, nextVersion, slabs: config.incomeTaxSlabs[taxRegime] };
  });

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="TDS Computation"
        description="An approved, employee-wise TDS figure payroll deducts from — instead of estimating it fresh from that month's pay."
      />

      <Card className="mb-6">
        <form method="get" className="flex flex-wrap items-end gap-4">
          <Field label="Employee">
            <select name="employeeId" defaultValue={sp.employeeId ?? data.employees[0]?.id} className={cx(inputAuto, "w-64")}>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employeeCode})</option>
              ))}
            </select>
          </Field>
          <Field label="Financial year">
            <select name="fy" defaultValue={financialYear} className={cx(inputAuto, "w-32")}>
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>{fyLabel(fy)}</option>
              ))}
            </select>
          </Field>
          <Field label="Tax regime">
            <select name="regime" defaultValue={taxRegime} className={cx(inputAuto, "w-32")}>
              <option value="NEW">New regime</option>
              <option value="OLD">Old regime</option>
            </select>
          </Field>
          <button className={buttonClass("secondary")}>Go</button>
        </form>
      </Card>

      {!data.employee ? (
        <Alert tone="warning">No employees to compute TDS for yet.</Alert>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader
              title={`Compute — ${data.employee.firstName} ${data.employee.lastName}, FY ${fyLabel(financialYear)}`}
              description={data.employee.taxRegime !== taxRegime ? `Their profile currently has the ${data.employee.taxRegime === "OLD" ? "old" : "new"} regime selected — this computation is for the ${taxRegime === "OLD" ? "old" : "new"} regime regardless.` : undefined}
            />
            <TdsComputeForm
              employeeId={data.employee.id}
              financialYear={financialYear}
              taxRegime={taxRegime}
              initialGrossIncome={data.preview!.grossIncome}
              initialDeductionLines={data.preview!.deductionLines}
              tdsAlreadyDeducted={data.preview!.tdsAlreadyDeducted}
              remainingMonths={data.preview!.remainingMonths}
              slabs={data.slabs!}
              nextVersion={data.nextVersion!}
            />
          </Card>

          <h2 className="mb-3 text-base font-semibold text-ink">Version history — FY {fyLabel(financialYear)}</h2>
          <TableCard>
            <Table>
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>Status</Th>
                  <Th>Regime</Th>
                  <Th align="right">Annual TDS</Th>
                  <Th align="right">Already deducted</Th>
                  <Th align="right">Balance</Th>
                  <Th align="right">Monthly</Th>
                  <Th>Reason</Th>
                  <Th>Created</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.history!.map((h) => (
                  <Tr key={h.id}>
                    <Td>
                      <span className="font-medium text-ink">V{h.version}</span>
                      {h.status === "APPROVED" && <Badge tone="green">Active</Badge>}
                    </Td>
                    <Td><StatusBadge status={h.status} /></Td>
                    <Td>{h.taxRegime === "OLD" ? "Old" : "New"}</Td>
                    <Td align="right" numeric>{inr(h.annualTdsLiability)}</Td>
                    <Td align="right" numeric>{inr(h.tdsAlreadyDeducted)}</Td>
                    <Td align="right" numeric>{inr(h.balanceTds)}</Td>
                    <Td align="right" numeric className="font-medium">{inr(h.monthlyTds)}</Td>
                    <Td className="max-w-48 truncate text-ink-soft">{h.revisionReason ?? "—"}</Td>
                    <Td className="whitespace-nowrap text-ink-soft">{fmtDate(h.createdAt)}</Td>
                    <Td align="right">
                      {h.status === "DRAFT" && (
                        <div className="flex justify-end gap-3">
                          <form action={approveTdsAction.bind(null, h.id)}>
                            <button className="text-xs font-medium text-brand-700 hover:underline">Approve</button>
                          </form>
                          <form action={withdrawTdsAction.bind(null, h.id)}>
                            <button className="text-xs font-medium text-rose-700 hover:underline">Withdraw</button>
                          </form>
                        </div>
                      )}
                    </Td>
                  </Tr>
                ))}
                {data.history!.length === 0 && <EmptyRow colSpan={10}>No computation for this employee and year yet.</EmptyRow>}
              </tbody>
            </Table>
          </TableCard>
        </>
      )}
    </div>
  );
}
