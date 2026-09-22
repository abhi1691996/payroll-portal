import { signOut } from "@/auth";
import { AppShell, type NavSection } from "@/components/app-shell";
import { Icon } from "@/components/icons";
import { requireSuperAdmin } from "@/server/rbac/guard";

const SECTIONS: NavSection[] = [
  {
    title: "Platform",
    items: [
      { href: "/platform", label: "Dashboard", icon: "dashboard" },
      { href: "/platform/clients", label: "Clients", icon: "building" },
    ],
  },
];

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  // Company users are redirected to their own portal.
  const ctx = await requireSuperAdmin();

  return (
    <AppShell
      sections={SECTIONS}
      email={ctx.email}
      role="Super admin"
      companyName="Platform admin"
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
