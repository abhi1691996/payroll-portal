import { requirePermission } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import { withTenant } from "@/server/tenancy/db";
import { formatHours, formatMinutes, toHHMM } from "@/lib/time";
import { shiftSpanMinutes } from "@/lib/attendance/engine";
import { Badge, Card, CardHeader, SubmitButton, TextInput } from "@/components/ui";
import { saveShift } from "../rules-actions";

interface ShiftRow {
  id: string; name: string; startMinutes: number; endMinutes: number; breakMinutes: number;
  lateGraceMinutes: number; earlyLeaveGraceMinutes: number; isFlexible: boolean; flexibleMinutes: number | null; active: boolean;
}

function ShiftForm({ shift, canEdit, isDefault }: { shift?: ShiftRow; canEdit: boolean; isDefault?: boolean }) {
  const key = shift ? JSON.stringify(shift) : "new";
  return (
    <form key={key} action={saveShift} className="grid gap-4 sm:grid-cols-4">
      {shift && <input type="hidden" name="id" value={shift.id} />}
      <fieldset disabled={!canEdit} className="contents">
        <TextInput label="Shift name" name="name" required defaultValue={shift?.name} placeholder="e.g. Night" className="sm:col-span-2" />
        <TextInput label="Start" name="start" type="time" required defaultValue={shift ? toHHMM(shift.startMinutes) : "09:30"} />
        <TextInput label="End" name="end" type="time" required defaultValue={shift ? toHHMM(shift.endMinutes) : "18:30"} hint="An end before the start means the shift crosses midnight." />
        <TextInput label="Break (minutes)" name="breakMinutes" type="number" min={0} max={240} defaultValue={shift?.breakMinutes ?? 60} />
        <TextInput label="Late grace (minutes)" name="lateGraceMinutes" type="number" min={0} defaultValue={shift?.lateGraceMinutes ?? 15} />
        <TextInput label="Early-leaving grace (minutes)" name="earlyLeaveGraceMinutes" type="number" min={0} defaultValue={shift?.earlyLeaveGraceMinutes ?? 15} />
        <div className="flex flex-col justify-end gap-2 text-sm text-ink">
          <label className="flex items-center gap-2">
            <input name="isFlexible" type="checkbox" defaultChecked={shift?.isFlexible} className="size-4 rounded border-line accent-brand-600" /> Flexible timing
          </label>
          <label className="flex items-center gap-2">
            <input name="active" type="checkbox" defaultChecked={shift?.active ?? true} disabled={isDefault} className="size-4 rounded border-line accent-brand-600" /> Active
            {isDefault && <input type="hidden" name="active" value="on" />}
          </label>
        </div>
        <TextInput label="Flexible: hours required per day" name="flexibleHours" type="number" step="0.25" defaultValue={shift?.flexibleMinutes ? shift.flexibleMinutes / 60 : 8} hint="Only used for flexible shifts." className="sm:col-span-2" />
      </fieldset>
      {canEdit && (
        <div className="sm:col-span-4">
          <SubmitButton icon="check">{shift ? "Save shift" : "Create shift"}</SubmitButton>
        </div>
      )}
    </form>
  );
}

export default async function ShiftsPage() {
  const ctx = await requirePermission("settings.read", "COMPANY");
  const canEdit = can(ctx, "settings.write", "COMPANY");
  const { shifts, setting, counts } = await withTenant(ctx.companyId, async (db) => ({
    shifts: await db.shift.findMany({ orderBy: { createdAt: "asc" } }),
    setting: await db.companySetting.findFirstOrThrow(),
    counts: await db.employee.groupBy({ by: ["shiftId"], _count: { _all: true } }),
  }));
  const employeesOn = new Map(counts.map((c) => [c.shiftId, c._count._all]));

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-soft">
        The shift master. Each employee works one shift (set on their profile, or the company default). Late and
        early-leaving are measured against it.
      </p>

      {shifts.map((s) => {
        const isDefault = setting.defaultShiftId === s.id;
        const span = shiftSpanMinutes(s);
        return (
          <Card key={s.id}>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {s.name}
                  {isDefault && <Badge tone="brand">Company default</Badge>}
                  {!s.active && <Badge>Inactive</Badge>}
                  {s.endMinutes <= s.startMinutes && !s.isFlexible && <Badge tone="violet">Night shift</Badge>}
                </span>
              }
              description={
                s.isFlexible
                  ? `Flexible · ${formatHours(s.flexibleMinutes ?? 480)} a day · ${(employeesOn.get(s.id) ?? 0)} employees`
                  : `${formatMinutes(s.startMinutes)} – ${formatMinutes(s.endMinutes)} · ${formatHours(span - s.breakMinutes)} of work after a ${s.breakMinutes} min break · ${(employeesOn.get(s.id) ?? 0)} employees${isDefault ? ` (+ everyone on the default: ${employeesOn.get(null) ?? 0})` : ""}`
              }
            />
            <ShiftForm shift={s} canEdit={canEdit} isDefault={isDefault} />
          </Card>
        );
      })}

      {canEdit && (
        <Card>
          <CardHeader title="Add a shift" description="e.g. Morning, Evening, Night (10:00 PM – 6:00 AM), Flexible." />
          <ShiftForm canEdit />
        </Card>
      )}
    </div>
  );
}
