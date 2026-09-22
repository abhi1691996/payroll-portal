"use client";

import { useState } from "react";
import { WEEKDAY_LABELS, type WeekdayKey, type WeeklyPattern } from "@/lib/attendance/calendar";
import { inputClass } from "@/components/ui";

const ORDER: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th"];

/**
 * The working week: each weekday is Working, a weekly Off, or "Alternate" (off only in chosen weeks of the
 * month, e.g. 2nd and 4th Saturday).
 */
export function WeeklyPatternEditor({ initial, disabled }: { initial: WeeklyPattern; disabled?: boolean }) {
  const [pattern, setPattern] = useState<WeeklyPattern>(initial);

  return (
    <div className="divide-y divide-line/70 rounded-xl border border-line">
      {ORDER.map((day) => {
        const rule = pattern[day];
        return (
          <div key={day} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
            <span className="w-28 text-sm font-medium text-ink">{WEEKDAY_LABELS[day]}</span>
            <select
              name={`day_${day}`}
              value={rule.mode}
              disabled={disabled}
              aria-label={`${WEEKDAY_LABELS[day]} is`}
              onChange={(e) => setPattern((p) => ({ ...p, [day]: { mode: e.target.value as "WORKING" | "OFF" | "ALTERNATE", offWeeks: p[day].offWeeks ?? [] } }))}
              className={`${inputClass} w-44 py-1.5`}
            >
              <option value="WORKING">Working</option>
              <option value="OFF">Weekly off</option>
              <option value="ALTERNATE">Off in some weeks</option>
            </select>
            {rule.mode === "ALTERNATE" && (
              <div className="flex flex-wrap items-center gap-3 text-sm text-ink-soft" role="group" aria-label={`Weeks in which ${WEEKDAY_LABELS[day]} is off`}>
                <span>Off on the</span>
                {ORDINAL.map((label, i) => (
                  <label key={label} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      name={`week_${day}_${i + 1}`}
                      disabled={disabled}
                      checked={(rule.offWeeks ?? []).includes(i + 1)}
                      onChange={(e) =>
                        setPattern((p) => {
                          const weeks = new Set(p[day].offWeeks ?? []);
                          if (e.target.checked) weeks.add(i + 1);
                          else weeks.delete(i + 1);
                          return { ...p, [day]: { mode: "ALTERNATE", offWeeks: [...weeks].sort() } };
                        })
                      }
                      className="size-4 rounded border-line accent-brand-600"
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
