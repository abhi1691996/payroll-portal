import type { ReactNode } from "react";
import { Icon } from "./icons";

/**
 * Collapsible bulk-upload section. Uses native <details> so it needs no client JS and stays
 * mounted (keeping any chosen file/preview) while collapsed. Pages open it by default when
 * there's no data yet or the URL carries ?bulk=1.
 */
export function BulkPanel({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details id="bulk-upload" open={defaultOpen} className="group/panel fade-up mb-6 scroll-mt-6">
      <summary className="flex cursor-pointer list-none items-center gap-4 rounded-2xl border border-dashed border-brand-300 bg-brand-50/60 px-5 py-4 transition hover:border-brand-500 hover:bg-brand-50 group-open/panel:mb-4 group-open/panel:border-solid">
        <span className="grid size-10 place-items-center rounded-xl bg-brand-600 text-white shadow-sm shadow-brand-600/30">
          <Icon name="upload" className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-brand-900">{title}</span>
          <span className="block truncate text-sm text-brand-800/70">{subtitle}</span>
        </span>
        <Icon name="chevron-down" className="size-5 text-brand-700 transition group-open/panel:rotate-180" />
      </summary>
      {children}
    </details>
  );
}
