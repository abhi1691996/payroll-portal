import { requirePermission } from "@/server/rbac/guard";
import { withTenant } from "@/server/tenancy/db";
import { computeDashboardMetrics, metricDetails, type DashboardMetricKey } from "@/server/dashboard/management";
import { inr } from "@/lib/format";
import {
  Card,
  CardHeader,
  EmptyRow,
  PageHeader,
  StatCard,
  Table,
  TableCard,
  Td,
  TextInput,
  Th,
  Tr,
  buttonClass,
} from "@/components/ui";
import type { IconName } from "@/components/icons";

const todayIso = () => new Date().toISOString().slice(0, 10);

const CARDS: { key: DashboardMetricKey; label: string; icon: IconName; tone?: "brand" | "green" | "amber" | "red" | "sky" | "violet" }[] = [
  { key: "totalWorkforce", label: "Total workforce", icon: "users", tone: "brand" },
  { key: "present", label: "Present", icon: "check", tone: "green" },
  { key: "absent", label: "Absent", icon: "error", tone: "red" },
  { key: "wfh", label: "Work from home", icon: "building", tone: "sky" },
  { key: "halfDay", label: "Half day", icon: "clock", tone: "amber" },
  { key: "missedPunches", label: "Missed punches", icon: "warning", tone: "amber" },
  { key: "lateComings", label: "Late comings", icon: "clock", tone: "amber" },
  { key: "earlyLeaves", label: "Early leaves", icon: "clock", tone: "amber" },
  { key: "birthdays", label: "Birthdays", icon: "info", tone: "violet" },
  { key: "workAnniversaries", label: "Work anniversaries", icon: "info", tone: "violet" },
  { key: "weekOff", label: "Week off", icon: "attendance", tone: "sky" },
  { key: "dailyPayrollCost", label: "Daily payroll cost (est.)", icon: "payroll", tone: "brand" },
  { key: "departments", label: "Departments", icon: "building", tone: "sky" },
  { key: "suspensions", label: "Suspensions (active)", icon: "warning", tone: "red" },
  { key: "resignationsPending", label: "Resignations (pending)", icon: "leave", tone: "amber" },
  { key: "terminationsToday", label: "Terminations (effective today)", icon: "error", tone: "red" },
];

const VALUE_OF: Record<DashboardMetricKey, (m: Awaited<ReturnType<typeof computeDashboardMetrics>>) => string | number> = {
  totalWorkforce: (m) => m.totalWorkforce,
  present: (m) => m.present,
  absent: (m) => m.absent,
  wfh: (m) => m.wfh,
  halfDay: (m) => m.halfDay,
  missedPunches: (m) => m.missedPunches,
  lateComings: (m) => m.lateComings,
  earlyLeaves: (m) => m.earlyLeaves,
  birthdays: (m) => m.birthdays,
  workAnniversaries: (m) => m.workAnniversaries,
  weekOff: (m) => m.weekOff,
  dailyPayrollCost: (m) => inr(m.dailyPayrollCost, 0),
  departments: (m) => m.departmentCount,
  suspensions: (m) => m.suspensions,
  resignationsPending: (m) => m.resignationsPending,
  terminationsToday: (m) => m.terminationsToday,
};

export default async function ManagementDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; metric?: string }>;
}) {
  const ctx = await requirePermission("dashboard.read", "COMPANY");
  const sp = await searchParams;
  const dateStr = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso();
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  const metric = CARDS.find((c) => c.key === sp.metric)?.key ?? null;

  const { metrics, details } = await withTenant(ctx.companyId, async (db) => ({
    metrics: await computeDashboardMetrics(db, ctx.companyId, date),
    details: metric ? await metricDetails(db, ctx.companyId, date, metric) : null,
  }));

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Daily management dashboard"
        description="A one-day snapshot of workforce, attendance and payroll cost. Click any number for the details behind it."
      />

      <Card className="mb-6">
        <form method="get" className="flex flex-wrap items-end gap-4">
          <TextInput label="Date" name="date" type="date" defaultValue={dateStr} className="w-48" />
          <button className={buttonClass("secondary")}>Go</button>
        </form>
      </Card>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CARDS.map((c) => (
          <StatCard
            key={c.key}
            label={c.label}
            value={VALUE_OF[c.key](metrics)}
            icon={c.icon}
            tone={c.tone}
            href={`/management-dashboard?date=${dateStr}&metric=${c.key}`}
          />
        ))}
      </div>

      {metric && (
        <Card>
          <CardHeader
            title={CARDS.find((c) => c.key === metric)!.label}
            description={`Details behind this number for ${dateStr}.`}
          />
          <TableCard>
            <Table>
              <thead>
                <tr>
                  <Th>Employee</Th>
                  <Th>Department</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {details!.map((d, i) => (
                  <Tr key={`${d.employeeCode}-${i}`}>
                    <Td className="font-medium">{d.employeeCode ? `${d.name} (${d.employeeCode})` : d.name}</Td>
                    <Td>{d.department}</Td>
                    <Td className="text-ink-soft">{d.extra}</Td>
                  </Tr>
                ))}
                {details!.length === 0 && <EmptyRow colSpan={3}>Nothing to show for this number today.</EmptyRow>}
              </tbody>
            </Table>
          </TableCard>
        </Card>
      )}
    </div>
  );
}
