import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { loadRules } from "@/server/rules/load";
import { describePattern } from "@/lib/attendance/calendar";
import { fmtDate } from "@/lib/format";
import { Alert, Card, CardHeader, EmptyRow, Field, SubmitButton, Table, TableCard, Td, TextInput, Th, Tr, inputClass } from "@/components/ui";
import { addHoliday, deleteHoliday, saveAttendanceRules } from "../rules-actions";
import { WeeklyPatternEditor } from "./pattern-editor";

const Check = ({ name, defaultChecked, label, hint, disabled }: { name: string; defaultChecked: boolean; label: string; hint?: string; disabled?: boolean }) => (
  <label className="flex items-start gap-3 text-sm text-ink">
    <input name={name} type="checkbox" defaultChecked={defaultChecked} disabled={disabled} className="mt-0.5 size-4 rounded border-line accent-brand-600" />
    <span>
      {label}
      {hint && <span className="mt-0.5 block text-xs text-ink-muted">{hint}</span>}
    </span>
  </label>
);

export default async function AttendanceRulesPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");

  const { rules, pattern, holidays } = await withTenant(ctx.companyId, async (db) => ({
    ...(await loadRules(db, ctx.companyId)),
    holidays: await db.holiday.findMany({ orderBy: { date: "asc" }, where: { date: { gte: new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1)) } } }),
  }));
  const raw = await withTenant(ctx.companyId, (db) => db.attendanceRule.findFirstOrThrow());

  return (
    <div className="space-y-6">
      <form action={saveAttendanceRules} className="space-y-6">
        <fieldset disabled={!canEdit} className="contents">
          <Card>
            <CardHeader title="Working week" description={`Currently: ${describePattern(pattern)}`} />
            <WeeklyPatternEditor initial={pattern} disabled={!canEdit} />
          </Card>

          <Card>
            <CardHeader title="Late coming & early leaving" description="Grace minutes are set per shift (Shifts tab). These rules decide what happens beyond the grace." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="After the late grace, an employee is…">
                <select name="lateAction" defaultValue={raw.lateAction} className={inputClass}>
                  <option value="MARK_LATE">Marked late (still present)</option>
                  <option value="HALF_DAY">Marked half day</option>
                </select>
              </Field>
              <TextInput label="…half day only if late by at least (minutes)" name="lateHalfDayAfterMinutes" type="number" min={0} defaultValue={raw.lateHalfDayAfterMinutes ?? ""} hint="Blank = any late arrival. Only used when the choice on the left is half day." />
              <TextInput label="Every N late marks in a month cost one half day" name="lateCountPerHalfDay" type="number" min={0} defaultValue={raw.lateCountPerHalfDay} hint="0 = don't convert late marks into leave." />
              <Field label="Leaving early beyond the grace is…">
                <select name="earlyLeaveAction" defaultValue={raw.earlyLeaveAction} className={inputClass}>
                  <option value="MARK_EARLY">Only flagged</option>
                  <option value="HALF_DAY">Marked half day</option>
                </select>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Present, half day and absent" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput label="Worked less than this many hours = Half day" name="halfDayBelowHours" type="number" step="0.25" min={0} defaultValue={raw.halfDayBelowMinutes / 60} />
              <TextInput label="Worked less than this many hours = Absent" name="absentBelowHours" type="number" step="0.25" min={0} defaultValue={raw.absentBelowMinutes / 60} hint="0 = don't mark absent by hours." />
              <Field label="Only one punch (in or out) recorded">
                <select name="missingPunchAction" defaultValue={raw.missingPunchAction} className={inputClass}>
                  <option value="PRESENT">Present (flagged for review)</option>
                  <option value="HALF_DAY">Half day (flagged)</option>
                  <option value="ABSENT">Absent (flagged)</option>
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Check
                  name="absentIfNoRecord"
                  defaultChecked={raw.absentIfNoRecord}
                  label="No attendance = Absent"
                  hint="A working day with no attendance, no approved leave, and that isn't a holiday or weekly off counts as absent (loss of pay). Turn this on only once attendance is being recorded for everyone — otherwise unrecorded days cost pay."
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Overtime" description="Overtime hours = hours worked beyond the shift's scheduled hours. They are always tracked once switched on; whether they are PAID is a separate choice." />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-3 sm:col-span-2">
                <Check name="otEnabled" defaultChecked={raw.otEnabled} label="Track overtime" />
                <Check name="otPayable" defaultChecked={raw.otPayable} label="Overtime is payable" hint="Adds an Overtime earning to payroll: hourly rate (Basic ÷ working days ÷ shift hours) × multiplier × overtime hours." />
                <Check name="otOnOffDays" defaultChecked={raw.otOnOffDays} label="Time worked on a weekly off or holiday counts as overtime" />
              </div>
              <TextInput label="Ignore overtime shorter than (minutes)" name="otMinMinutes" type="number" min={0} defaultValue={raw.otMinMinutes} />
              <TextInput label="Pay multiplier" name="otMultiplier" type="number" step="0.25" min={1} defaultValue={Number(raw.otMultiplier)} hint="1.5 = time and a half; 2 = double." />
            </div>
            {rules.otEnabled && !rules.otPayable && <div className="mt-4"><Alert tone="info">Overtime is tracked and shown in attendance, but not paid.</Alert></div>}
          </Card>
        </fieldset>
        {canEdit && <SubmitButton icon="check">Save attendance rules</SubmitButton>}
      </form>

      <Card>
        <CardHeader title="Holidays" description="Holidays are not working days: they aren't absences and aren't counted as leave." />
        <TableCard>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Holiday</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => (
                <Tr key={h.id}>
                  <Td className="whitespace-nowrap">{fmtDate(h.date)}</Td>
                  <Td>{h.name}</Td>
                  <Td align="right">
                    {canEdit && (
                      <form action={deleteHoliday.bind(null, h.id)}>
                        <button className="text-xs font-medium text-rose-700 hover:underline">Remove</button>
                      </form>
                    )}
                  </Td>
                </Tr>
              ))}
              {holidays.length === 0 && <EmptyRow colSpan={3}>No holidays added yet.</EmptyRow>}
            </tbody>
          </Table>
        </TableCard>
        {canEdit && (
          <form action={addHoliday} className="mt-4 flex flex-wrap items-end gap-3">
            <TextInput label="Date" name="date" type="date" required />
            <TextInput label="Name" name="name" required placeholder="e.g. Independence Day" />
            <SubmitButton icon="plus">Add holiday</SubmitButton>
          </form>
        )}
      </Card>
    </div>
  );
}
