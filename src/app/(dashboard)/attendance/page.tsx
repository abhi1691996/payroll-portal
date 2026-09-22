import Link from "next/link";
import type { AttendanceStatus } from "@prisma/client";
import { requirePermission } from "@/server/rbac/guard";
import { SEPARATED_STATUSES } from "@/server/employees/lifecycle";
import { can, employeeScopeWhere } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { daysInMonth, monthLabel, weekdayLabel } from "@/lib/dates";
import { ATTENDANCE_SHORT_CODE } from "@/lib/bulk/parse";
import { titleCase } from "@/lib/format";
import { BulkImport } from "@/components/bulk-import";
import { BulkPanel } from "@/components/bulk-panel";
import {
  Avatar,
  Badge,
  Card,
  EmptyRow,
  LinkButton,
  MonthSwitcher,
  PageHeader,
  StatCard,
  SubmitButton,
  Table,
  TableCard,
  Tabs,
  Td,
  Th,
  Tr,
  cx,
  inputAuto,
  inputCompact,
  buttonClass,
} from "@/components/ui";
import { loadHolidays, loadRules } from "@/server/rules/load";
import { classifyDay } from "@/lib/attendance/calendar";
import { formatHours, minutesSinceLocalMidnight, toHHMM, formatMinutes } from "@/lib/time";
import { saveAttendance } from "./actions";

const STATUS_OPTIONS = ["PRESENT", "ABSENT", "HALF_DAY", "HOLIDAY", "WEEK_OFF", "ON_LEAVE"] as const;

/** Cell colours for the month grid and the employee view. */
const CELL: Record<AttendanceStatus, string> = {
  PRESENT: "bg-emerald-50 text-emerald-700",
  ABSENT: "bg-rose-100 text-rose-700",
  HALF_DAY: "bg-amber-100 text-amber-800",
  HOLIDAY: "bg-sky-100 text-sky-700",
  WEEK_OFF: "bg-slate-100 text-slate-500",
  ON_LEAVE: "bg-violet-100 text-violet-700",
};

const STATUS_BADGE_TONE: Record<AttendanceStatus, "green" | "red" | "amber" | "sky" | "slate" | "violet"> = {
  PRESENT: "green",
  ABSENT: "red",
  HALF_DAY: "amber",
  HOLIDAY: "sky",
  WEEK_OFF: "slate",
  ON_LEAVE: "violet",
};

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-soft" aria-label="Legend">
      {STATUS_OPTIONS.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={cx("grid size-5 place-items-center rounded text-[10px] font-bold", CELL[s])}>
            {ATTENDANCE_SHORT_CODE[s]}
          </span>
          {titleCase(s)}
        </li>
      ))}
    </ul>
  );
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ employeeId?: string; year?: string; month?: string; view?: string; bulk?: string }>;
}) {
  const ctx = await requirePermission("attendance.read", "OWN");
  // Anyone who can mark attendance (admin/HR: everyone, manager: their team) gets the management
  // views; everyone else sees only their own record.
  const isAdmin = can(ctx, "attendance.write", "TEAM");
  const canImport = can(ctx, "attendance.import", "COMPANY");
  const params = await searchParams;

  const now = new Date();
  const year = Number(params.year) || now.getFullYear();
  const month = Math.min(12, Math.max(1, Number(params.month) || now.getMonth() + 1));
  const label = monthLabel(year, month);
  const total = daysInMonth(year, month);
  const days = Array.from({ length: total }, (_, i) => i + 1);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const view = params.view === "edit" ? "edit" : "grid";
  const monthQuery = `year=${year}&month=${month}`;

  /* ------------------------------ Employee view ----------------------------- */
  if (!isAdmin) {
    const records = ctx.employeeId
      ? await withTenant(ctx.companyId, (db) =>
          db.attendanceRecord.findMany({
            where: { employeeId: ctx.employeeId!, date: { gte: monthStart, lt: monthEnd } },
          })
        )
      : [];
    const byDay = new Map(records.map((r) => [r.date.getUTCDate(), r.status]));
    const recByDay = new Map(records.map((r) => [r.date.getUTCDate(), r]));
    const count = (s: AttendanceStatus) => records.filter((r) => r.status === s).length;

    return (
      <div className="max-w-3xl">
        <PageHeader
          title="My attendance"
          description="Your recorded attendance for the month."
          actions={<MonthSwitcher basePath="/attendance" year={year} month={month} label={label} />}
        />
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard label="Present" value={count("PRESENT")} icon="check" tone="green" />
          <StatCard label="Absent" value={count("ABSENT")} icon="error" tone="red" />
          <StatCard label="Half days" value={count("HALF_DAY")} icon="clock" tone="amber" />
          <StatCard label="On leave" value={count("ON_LEAVE")} icon="leave" tone="violet" />
        </div>
        <TableCard>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Day</Th>
                <Th>In</Th>
                <Th>Out</Th>
                <Th align="right">Worked</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => {
                const status = byDay.get(day);
                const rec = recByDay.get(day);
                const date = new Date(Date.UTC(year, month - 1, day));
                return (
                  <Tr key={day}>
                    <Td numeric>{day}</Td>
                    <Td className="text-ink-soft">{weekdayLabel(year, month, day)}</Td>
                    <Td numeric className="text-ink-soft">{rec?.inAt ? formatMinutes(minutesSinceLocalMidnight(rec.inAt, date)) : "—"}</Td>
                    <Td numeric className="text-ink-soft">{rec?.outAt ? formatMinutes(minutesSinceLocalMidnight(rec.outAt, date)) : "—"}</Td>
                    <Td align="right" numeric className="text-ink-soft">{rec && rec.workedMinutes ? formatHours(rec.workedMinutes) : "—"}</Td>
                    <Td>
                      {status ? (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={STATUS_BADGE_TONE[status]}>{titleCase(status)}</Badge>
                          {rec?.isLate && <Badge tone="amber">Late {rec.lateMinutes}m</Badge>}
                          {rec && rec.earlyLeaveMinutes > 0 && <Badge tone="amber">Early {rec.earlyLeaveMinutes}m</Badge>}
                          {rec && rec.overtimeMinutes > 0 && <Badge tone="sky">OT {formatHours(rec.overtimeMinutes)}</Badge>}
                        </span>
                      ) : (
                        <span className="text-ink-muted">Not recorded</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableCard>
      </div>
    );
  }

  /* ------------------------------- Admin views ------------------------------ */
  const scope = employeeScopeWhere(ctx, "attendance.read");
  const { employees, monthRecords } = await withTenant(ctx.companyId, async (db) => {
    const employees = await db.employee.findMany({
      where: { AND: [scope, { status: { notIn: SEPARATED_STATUSES } }] },
      orderBy: { employeeCode: "asc" },
    });
    const monthRecords =
      view === "grid"
        ? await db.attendanceRecord.findMany({
            where: { employeeId: { in: employees.map((e) => e.id) }, date: { gte: monthStart, lt: monthEnd } },
          })
        : [];
    return { employees, monthRecords };
  });

  const bulkPanel = !canImport ? null : (
    <BulkPanel
      title="Bulk upload attendance"
      subtitle={`Upload a monthly grid or a daily list for ${label}. Existing entries for the same days are replaced.`}
      defaultOpen={params.bulk === "1"}
    >
      <BulkImport
        kind="attendance"
        unit="row"
        title="Import attendance from CSV"
        description="Use the monthly grid (one row per employee, one column per day) or a daily list with in / out times (one row per employee per day). We detect which from the header."
        columnsHint="Grid: employeeCode, 1…31 with codes P A HD HOL WO L. List: employeeCode, date, then inTime and outTime (09:30, 9:30 AM, 18:30) and/or status — times are turned into a status by your shift and attendance rules."
        params={{ year, month }}
        templates={[
          { label: `Grid template (${label})`, href: `/bulk/attendance-grid/template.csv?${monthQuery}` },
          { label: "Daily list template", href: "/bulk/attendance/template.csv" },
        ]}
        exports={[{ label: `Export ${label}`, href: `/bulk/attendance-grid/export.csv?${monthQuery}` }]}
      >
        <div className="space-y-3 rounded-xl bg-canvas/70 p-4">
          <p className="text-sm text-ink-soft">
            <b className="font-medium text-ink">Monthly grid uploads apply to {label}</b> — change the month above first.
            The grid template is prefilled with every active employee. Blank cells are left untouched.
          </p>
          <Legend />
        </div>
      </BulkImport>
    </BulkPanel>
  );

  const header = (
    <PageHeader
      title="Attendance"
      description="Mark and review attendance. Loss-of-pay days are counted from Absent and Half day entries when payroll runs."
      actions={
        <>
          <MonthSwitcher
            basePath="/attendance"
            year={year}
            month={month}
            label={label}
            extraParams={{ view: view === "edit" ? "edit" : undefined, employeeId: params.employeeId }}
          />
          {canImport && (
            <LinkButton
              href={`/bulk/attendance-grid/export.csv?${monthQuery}`}
              variant="secondary"
              icon="download"
              download
            >
              Export
            </LinkButton>
          )}
        </>
      }
    />
  );

  const tabs = (
    <Tabs
      items={[
        { href: `/attendance?${monthQuery}`, label: "Month overview", active: view === "grid" },
        { href: `/attendance?view=edit&${monthQuery}`, label: "Edit one employee", active: view === "edit" },
      ]}
    />
  );

  /* ---------------------------- Admin: month grid --------------------------- */
  if (view === "grid") {
    const recordsByEmployee = new Map<string, typeof monthRecords>();
    for (const r of monthRecords) {
      recordsByEmployee.set(r.employeeId, [...(recordsByEmployee.get(r.employeeId) ?? []), r]);
    }

    const rows = employees.map((e) => {
      const records = recordsByEmployee.get(e.id) ?? [];
      const byDay = new Map(records.map((r) => [r.date.getUTCDate(), r.status]));
      const count = (s: AttendanceStatus) => records.filter((r) => r.status === s).length;
      return {
        e,
        byDay,
        present: count("PRESENT") + count("HALF_DAY") * 0.5,
        absent: count("ABSENT") + count("HALF_DAY") * 0.5,
        recorded: records.length,
      };
    });

    const withData = rows.filter((r) => r.recorded > 0).length;
    const totalAbsent = rows.reduce((sum, r) => sum + r.absent, 0);

    return (
      <div>
        {header}
        {tabs}
        {bulkPanel}

        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <StatCard label="Employees" value={rows.length} icon="users" tone="brand" hint="Active or on leave" />
          <StatCard
            label="With attendance recorded"
            value={`${withData}/${rows.length}`}
            icon="attendance"
            tone={withData === rows.length && rows.length > 0 ? "green" : "amber"}
            hint={label}
          />
          <StatCard label="Loss-of-pay days" value={totalAbsent} icon="warning" tone="red" hint="Absent + half days" />
        </div>

        <Card padded={false}>
          <div className="border-b border-line px-5 py-3">
            <Legend />
          </div>
          <div className="thin-scroll overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 min-w-52 border-b border-line bg-surface px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    Employee
                  </th>
                  {days.map((d) => (
                    <th
                      key={d}
                      className="min-w-8 border-b border-line px-0.5 py-2 text-center text-xs font-medium text-ink-muted"
                    >
                      <span className="block tabular-nums">{d}</span>
                      <span className="block text-[10px] font-normal opacity-70">
                        {weekdayLabel(year, month, d)[0]}
                      </span>
                    </th>
                  ))}
                  <th className="border-b border-line px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    P
                  </th>
                  <th className="border-b border-line px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    LOP
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, byDay, present, absent }) => (
                  <tr key={e.id} className="group">
                    <td className="sticky left-0 z-10 border-b border-line/70 bg-surface px-4 py-2 group-hover:bg-brand-50">
                      <Link
                        href={`/attendance?view=edit&employeeId=${e.id}&${monthQuery}`}
                        className="flex items-center gap-2.5"
                      >
                        <Avatar name={`${e.firstName} ${e.lastName}`} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink hover:text-brand-700">
                            {e.firstName} {e.lastName}
                          </span>
                          <span className="block font-mono text-[11px] text-ink-muted">{e.employeeCode}</span>
                        </span>
                      </Link>
                    </td>
                    {days.map((d) => {
                      const s = byDay.get(d);
                      return (
                        <td key={d} className="border-b border-line/70 p-0.5 text-center">
                          {s ? (
                            <span
                              title={`${d} ${label} — ${titleCase(s)}`}
                              className={cx(
                                "grid h-7 w-7 place-items-center rounded-md text-[11px] font-bold",
                                CELL[s]
                              )}
                            >
                              {ATTENDANCE_SHORT_CODE[s]}
                            </span>
                          ) : (
                            <span className="text-ink-muted/40">·</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border-b border-line/70 px-3 text-right font-medium tabular-nums text-ink">
                      {present}
                    </td>
                    <td
                      className={cx(
                        "border-b border-line/70 px-3 text-right font-medium tabular-nums",
                        absent > 0 ? "text-rose-600" : "text-ink-muted"
                      )}
                    >
                      {absent}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <EmptyRow colSpan={days.length + 3}>No employees yet.</EmptyRow>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    );
  }

  /* --------------------------- Admin: edit one person ----------------------- */
  const employeeId = params.employeeId ?? employees[0]?.id ?? "";
  const selected = employees.find((e) => e.id === employeeId);
  // `selected` comes from the scoped employee list, so an id outside the caller's scope yields nothing.
  const editData =
    selected && employeeId
      ? await withTenant(ctx.companyId, async (db) => {
          const records = await db.attendanceRecord.findMany({ where: { employeeId, date: { gte: monthStart, lt: monthEnd } } });
          const { pattern, shiftFor } = await loadRules(db, ctx.companyId);
          const holidays = await loadHolidays(db, monthStart, new Date(monthEnd.getTime() - 86_400_000));
          return { records, pattern, holidays, shift: shiftFor(selected) };
        })
      : null;
  const recByDay = new Map((editData?.records ?? []).map((r) => [r.date.getUTCDate(), r]));
  const saveWithContext = employeeId ? saveAttendance.bind(null, employeeId, year, month) : undefined;

  return (
    <div>
      {header}
      {tabs}
      {bulkPanel}

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value="edit" />
        <input type="hidden" name="year" value={year} />
        <input type="hidden" name="month" value={month} />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Employee</span>
          <select name="employeeId" defaultValue={employeeId} className={cx(inputAuto, "min-w-64")}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.firstName} {e.lastName} ({e.employeeCode})
              </option>
            ))}
          </select>
        </label>
        <button className={buttonClass("secondary")}>Show</button>
      </form>

      {selected && saveWithContext ? (
        <form key={`${employeeId}-${year}-${month}-${editData?.records.length}`} action={saveWithContext}>
          <TableCard>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Day</Th>
                  <Th>In time</Th>
                  <Th>Out time</Th>
                  <Th align="right">Worked</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => {
                  const rec = recByDay.get(day);
                  const date = new Date(Date.UTC(year, month - 1, day));
                  const type = editData ? classifyDay(date, editData.pattern, editData.holidays) : "WORKING";
                  const inValue = rec?.inAt ? toHHMM(minutesSinceLocalMidnight(rec.inAt, date)) : "";
                  const outValue = rec?.outAt ? toHHMM(minutesSinceLocalMidnight(rec.outAt, date)) : "";
                  // A status that differs from what the times alone would give is a manual override; show it as chosen.
                  const status = rec ? (rec.inAt || rec.outAt ? "AUTO" : rec.status) : "AUTO";
                  return (
                    <Tr key={day} className={type !== "WORKING" ? "bg-canvas/60" : undefined}>
                      <Td numeric className="w-16 font-medium">{day}</Td>
                      <Td className="w-32 text-ink-soft">
                        {weekdayLabel(year, month, day)}
                        {type === "WEEKLY_OFF" && <span className="ml-2 text-xs text-ink-muted">off</span>}
                        {type === "HOLIDAY" && <span className="ml-2 text-xs text-sky-700">holiday</span>}
                      </Td>
                      <Td className="py-1.5">
                        <input type="time" name={`in-${day}`} defaultValue={inValue} aria-label={`In time for ${day} ${label}`} className={cx(inputCompact, "w-32")} />
                      </Td>
                      <Td className="py-1.5">
                        <input type="time" name={`out-${day}`} defaultValue={outValue} aria-label={`Out time for ${day} ${label}`} className={cx(inputCompact, "w-32")} />
                      </Td>
                      <Td align="right" numeric className="whitespace-nowrap text-ink-soft">
                        {rec && rec.workedMinutes ? formatHours(rec.workedMinutes) : "—"}
                      </Td>
                      <Td className="py-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <select name={`status-${day}`} defaultValue={status} aria-label={`Status for ${day} ${label}`} className={cx(inputCompact, "w-44")}>
                            <option value="AUTO">Auto (from times)</option>
                            {STATUS_OPTIONS.map((s) => (
                              <option key={s} value={s}>{titleCase(s)}</option>
                            ))}
                          </select>
                          {rec && (
                            <span className="flex flex-wrap gap-1">
                              <Badge tone={STATUS_BADGE_TONE[rec.status]}>{titleCase(rec.status)}</Badge>
                              {rec.isLate && <Badge tone="amber">Late {rec.lateMinutes}m</Badge>}
                              {rec.earlyLeaveMinutes > 0 && <Badge tone="amber">Early {rec.earlyLeaveMinutes}m</Badge>}
                              {rec.overtimeMinutes > 0 && <Badge tone="sky">OT {formatHours(rec.overtimeMinutes)}</Badge>}
                              {rec.flags?.includes("MISSING_PUNCH") && <Badge tone="red">Missing punch</Badge>}
                            </span>
                          )}
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <div className="flex flex-wrap items-center gap-4 border-t border-line bg-canvas/50 px-5 py-4">
              <SubmitButton icon="check">Save attendance</SubmitButton>
              <p className="max-w-xl text-sm text-ink-muted">
                {selected.firstName}&apos;s {label}. Enter in / out times and the status, late, early-leave and overtime are worked out from
                their shift ({editData ? `${editData.shift.isFlexible ? "flexible" : formatMinutes(editData.shift.startMinutes) + " – " + formatMinutes(editData.shift.endMinutes)}` : ""})
                and your attendance rules. Pick a status to override. Leave both empty on a working day to clear it.
              </p>
            </div>
          </TableCard>
        </form>
      ) : (
        <Card>
          <p className="text-sm text-ink-muted">No employees to show yet.</p>
        </Card>
      )}
    </div>
  );
}
