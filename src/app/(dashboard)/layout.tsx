import { signOut } from "@/auth";
import { AppShell, type NavItem, type NavSection } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { requireTenant } from "@/server/rbac/guard";
import { can } from "@/server/rbac/context";
import type { PermissionKey } from "@/server/rbac/permissions";
import { withTenant } from "@/server/tenancy/db";
import type { PermissionScope } from "@prisma/client";

interface NavEntry extends NavItem {
  /** Permission(s) required to see this item (at `minScope` or wider) — any one is enough. Omit for "everyone". */
  permission?: PermissionKey | PermissionKey[];
  minScope?: PermissionScope;
}

const SECTIONS: { title: string; items: NavEntry[] }[] = [
  {
    title: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: "dashboard" }],
  },
  {
    title: "People",
    items: [
      { href: "/employees", label: "Employees", icon: "users", permission: "employee.read", minScope: "TEAM" },
      { href: "/attendance", label: "Attendance", icon: "attendance", permission: "attendance.read" },
      { href: "/leave", label: "Leave", icon: "leave", permission: "leave.read" },
      { href: "/loans", label: "Loans & advances", icon: "payroll", permission: ["loan.request", "loan.manage"] },
    ],
  },
  {
    title: "Payroll",
    items: [
      { href: "/payroll/runs", label: "Payroll runs", icon: "payroll", permission: "payroll.read", minScope: "COMPANY" },
      { href: "/payroll/tds", label: "TDS Computation", icon: "reports", permission: "tds.manage", minScope: "COMPANY" },
      { href: "/payslips", label: "Payslips", icon: "payslip", permission: "payslip.read" },
      { href: "/reports", label: "Reports", icon: "reports", permission: "report.read", minScope: "COMPANY" },
    ],
  },
  {
    title: "Admin",
    items: [
      { href: "/settings", label: "Settings", icon: "settings", permission: "settings.read", minScope: "COMPANY" },
    ],
  },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Sends signed-out users to /login and Super Admins to /platform.
  const ctx = await requireTenant();

  const company = await withTenant(ctx.companyId, (db) => db.company.findFirst({ select: { name: true } }));

  // Navigation is just a convenience: every page and action re-checks permissions on the server.
  const sections: NavSection[] = SECTIONS.map((section) => ({
    title: section.title,
    items: section.items
      .filter((item) => !item.permission || [item.permission].flat().some((p) => can(ctx, p, item.minScope ?? "OWN")))
      .map(({ href, label, icon }) => ({ href, label, icon })),
  })).filter((section) => section.items.length > 0);

  return (
    <AppShell
      sections={sections}
      email={ctx.email}
      role={ctx.roleKeys[0]?.replaceAll("_", " ") ?? "User"}
      companyName={company?.name ?? "Payroll Portal"}
      signOut={
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button
            type="submit"
            className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-brand-100/75 transition hover:bg-white/5 hover:text-white"
          >
            <Icon name="log-out" className="size-[18px] text-brand-300/60" />
            Sign out
          </button>
        </form>
      }
    >
      {children}
    </AppShell>
  );
}
