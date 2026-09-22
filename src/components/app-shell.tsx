"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Avatar, cx } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Brand({ companyName }: { companyName: string }) {
  return (
    <div className="flex items-center gap-3 px-5 py-5">
      <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-lg font-bold text-white shadow-lg shadow-brand-900/40">
        ₹
      </span>
      <div className="leading-tight">
        <p className="max-w-40 truncate text-[15px] font-semibold text-white">{companyName}</p>
        <p className="text-xs text-brand-200/70">Payroll Portal</p>
      </div>
    </div>
  );
}

function NavList({ sections, pathname }: { sections: NavSection[]; pathname: string }) {
  // Only the most specific match is highlighted, so /platform/clients does not also light up /platform.
  const activeHref = sections
    .flatMap((s) => s.items)
    .filter((i) => isActive(pathname, i.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav className="thin-scroll flex-1 space-y-6 overflow-y-auto px-3 pb-4">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-brand-300/60">
            {section.title}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = item.href === activeHref;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                      active
                        ? "bg-white/10 text-white"
                        : "text-brand-100/75 hover:bg-white/5 hover:text-white"
                    )}
                  >
                    {active && (
                      <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-brand-400" aria-hidden />
                    )}
                    <Icon
                      name={item.icon}
                      className={cx("size-[18px]", active ? "text-brand-300" : "text-brand-300/60 group-hover:text-brand-300")}
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({
  sections,
  email,
  role,
  companyName,
  signOut,
  children,
}: {
  sections: NavSection[];
  email: string;
  role: string;
  companyName: string;
  /** Server-rendered sign-out form button, passed in so this component can stay client-only UI. */
  signOut: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // The drawer is "open" only for the path it was opened on, so navigating closes it.
  const [openOnPath, setOpenOnPath] = useState<string | null>(null);
  const open = openOnPath === pathname;
  const setOpen = (value: boolean) => setOpenOnPath(value ? pathname : null);

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-950">
      <Brand companyName={companyName} />
      <NavList sections={sections} pathname={pathname} />
      <div className="border-t border-white/10 p-3">
        <div className="flex items-center gap-3 rounded-xl px-2 py-2">
          <Avatar name={email.split("@")[0].replace(/[._]/g, " ")} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{email}</p>
            <p className="text-xs capitalize text-brand-200/60">{role.toLowerCase()}</p>
          </div>
        </div>
        {signOut}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar}</aside>

      {/* Mobile top bar */}
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          className="grid size-10 place-items-center rounded-xl border border-line text-ink-soft hover:bg-brand-50"
        >
          <Icon name="menu" />
        </button>
        <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 font-bold text-white">
          ₹
        </span>
        <span className="truncate font-semibold text-ink">{companyName}</span>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-brand-950/50 backdrop-blur-sm"
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-pop">
            {sidebar}
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 grid size-8 place-items-center rounded-lg text-brand-200 hover:bg-white/10"
            >
              <Icon name="close" className="size-4" />
            </button>
          </aside>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">{children}</main>
    </div>
  );
}
