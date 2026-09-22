"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const TABS = [
  { href: "/settings", label: "Company" },
  { href: "/settings/employee", label: "Employees" },
  { href: "/settings/salary", label: "Salary rules" },
  { href: "/settings/shifts", label: "Shifts" },
  { href: "/settings/attendance", label: "Attendance rules" },
  { href: "/settings/leave", label: "Leave rules" },
  { href: "/settings/approvals", label: "Approval rules" },
  { href: "/settings/compliance", label: "Compliance rules" },
];

/** Section navigation for Settings; the active tab follows the URL. */
export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="thin-scroll mb-6 flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-sm">
      {TABS.map((t) => {
        const active = t.href === "/settings" ? pathname === "/settings" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition",
              active ? "bg-brand-600 text-white shadow-sm" : "text-ink-soft hover:bg-brand-50 hover:text-brand-800"
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
