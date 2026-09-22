import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { titleCase } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/*  Small building blocks shared by every page. Server-safe (no hooks/state).  */
/* -------------------------------------------------------------------------- */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="fade-up mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && (
          <Link
            href={back.href}
            className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-ink-muted hover:text-brand-700"
          >
            <Icon name="chevron-left" className="size-4" />
            {back.label}
          </Link>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cx(
        "rounded-2xl border border-line bg-surface shadow-card",
        padded && "p-5 sm:p-6",
        className
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-soft">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type Tone = "brand" | "green" | "amber" | "red" | "sky" | "slate" | "violet";

const TONE_SOFT: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand-700 ring-brand-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-rose-50 text-rose-700 ring-rose-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};

const TONE_ICON: Record<Tone, string> = {
  brand: "bg-brand-50 text-brand-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-rose-50 text-rose-600",
  sky: "bg-sky-50 text-sky-600",
  slate: "bg-slate-100 text-slate-600",
  violet: "bg-violet-50 text-violet-600",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_SOFT[tone]
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "green",
  ON_LEAVE: "amber",
  SUSPENDED: "red",
  RESIGNED: "slate",
  TERMINATED: "slate",
  PENDING: "amber",
  APPROVED: "green",
  REJECTED: "red",
  WITHDRAWN: "slate",
  CANCELLED: "slate",
  DRAFT: "slate",
  PROCESSED: "sky",
  FINALIZED: "green",
  OLD: "violet",
  NEW: "brand",
};

/** Colour-coded pill for any status enum used in the app. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "slate"}>{titleCase(status)}</Badge>;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "brand",
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: IconName;
  tone?: Tone;
  href?: string;
}) {
  const body = (
    <div
      className={cx(
        "fade-up group relative h-full rounded-2xl border border-line bg-surface p-5 shadow-card transition",
        href && "hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-pop"
      )}
    >
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-ink-soft">{label}</p>
        <span className={cx("grid size-9 place-items-center rounded-xl", TONE_ICON[tone])}>
          <Icon name={icon} className="size-[18px]" />
        </span>
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

/* ------------------------------- Buttons ---------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function buttonClass(variant: ButtonVariant = "primary", size: "md" | "sm" = "md"): string {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition",
    "disabled:cursor-not-allowed disabled:opacity-50",
    size === "md" ? "px-4 py-2.5 text-sm" : "px-3 py-1.5 text-[13px]",
    variant === "primary" &&
      "bg-brand-600 text-white shadow-sm shadow-brand-600/25 hover:bg-brand-700 active:bg-brand-800",
    variant === "secondary" &&
      "border border-line bg-surface text-ink hover:border-brand-200 hover:bg-brand-50 hover:text-brand-800",
    variant === "ghost" && "text-ink-soft hover:bg-brand-50 hover:text-brand-800",
    variant === "danger" && "bg-rose-600 text-white hover:bg-rose-700"
  );
}

export function LinkButton({
  href,
  variant = "primary",
  size = "md",
  icon,
  children,
  download,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconName;
  children: ReactNode;
  /** Plain <a> for file downloads so Next doesn't try to client-navigate to a CSV. */
  download?: boolean;
}) {
  const className = buttonClass(variant, size);
  const content = (
    <>
      {icon && <Icon name={icon} className="size-4" />}
      {children}
    </>
  );
  return download ? (
    <a href={href} className={className}>
      {content}
    </a>
  ) : (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

export function SubmitButton({
  children,
  variant = "primary",
  icon,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  icon?: IconName;
}) {
  return (
    <button type="submit" className={buttonClass(variant)}>
      {icon && <Icon name={icon} className="size-4" />}
      {children}
    </button>
  );
}

/* -------------------------------- Forms ----------------------------------- */

// Width and padding are deliberately kept out of the base so callers can size a control
// without fighting a competing utility (Tailwind resolves same-property clashes by stylesheet
// order, not by the order of classes in the attribute).
const inputBase =
  "block rounded-xl border border-line bg-surface text-sm text-ink placeholder:text-ink-muted " +
  "shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100";

/** Full-width control (default in forms). */
export const inputClass = `${inputBase} w-full px-3.5 py-2.5`;
/** Standard padding, width set by the caller (filters, toolbars). */
export const inputAuto = `${inputBase} px-3.5 py-2.5`;
/** Compact control for dense tables; width set by the caller. */
export const inputCompact = `${inputBase} px-3 py-1.5`;

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  /** Validation message; replaces the hint and is announced to screen readers. */
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-xs font-medium text-rose-600">
          {error}
        </span>
      ) : (
        hint && <span className="mt-1 block text-xs text-ink-muted">{hint}</span>
      )}
    </label>
  );
}

export function TextInput({
  label,
  name,
  type = "text",
  required,
  placeholder,
  defaultValue,
  hint,
  error,
  step,
  min,
  max,
  className,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number;
  hint?: string;
  error?: string;
  step?: string;
  min?: number;
  max?: number;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        step={step}
        min={min}
        max={max}
        aria-invalid={error ? true : undefined}
        className={cx(inputClass, error && "border-rose-400 focus:border-rose-500 focus:ring-rose-100")}
      />
    </Field>
  );
}

/* -------------------------------- Tables ---------------------------------- */

export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="fade-up overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      <div className="thin-scroll overflow-x-auto">{children}</div>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="min-w-full text-sm">{children}</table>;
}

export function Th({
  children,
  align = "left",
  className,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cx(
        "whitespace-nowrap border-b border-line bg-canvas/60 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-muted",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  numeric,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  numeric?: boolean;
}) {
  return (
    <td
      className={cx(
        "border-b border-line/70 px-4 py-3 text-ink",
        align === "right" && "text-right",
        align === "center" && "text-center",
        numeric && "tabular-nums",
        className
      )}
    >
      {children}
    </td>
  );
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cx("transition-colors hover:bg-brand-50/40", className)}>{children}</tr>;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-14 text-center text-sm text-ink-muted">
        {children}
      </td>
    </tr>
  );
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const parts = name.trim().split(/\s+/);
  const text = `${parts[0]?.[0] ?? ""}${parts.length > 1 ? parts[parts.length - 1][0] : ""}`.toUpperCase();
  return (
    <span
      className={cx(
        "grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-100 to-brand-200 font-semibold text-brand-800",
        size === "sm" && "size-8 text-xs",
        size === "md" && "size-9 text-sm",
        size === "lg" && "size-14 text-lg"
      )}
    >
      {text || "?"}
    </span>
  );
}

/* --------------------------------- Tabs ----------------------------------- */

export function Tabs({
  items,
}: {
  items: { href: string; label: string; active: boolean; count?: number }[];
}) {
  return (
    <nav
      aria-label="Sections"
      className="thin-scroll mb-5 inline-flex max-w-full overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-sm"
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cx(
            "flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition",
            item.active ? "bg-brand-600 text-white shadow-sm" : "text-ink-soft hover:bg-brand-50 hover:text-brand-800"
          )}
        >
          {item.label}
          {item.count !== undefined && (
            <span
              className={cx(
                "rounded-full px-1.5 text-xs tabular-nums",
                item.active ? "bg-white/20 text-white" : "bg-canvas text-ink-muted"
              )}
            >
              {item.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}

/** Previous / next month links that preserve any other query params. */
export function MonthSwitcher({
  basePath,
  year,
  month,
  label,
  extraParams = {},
}: {
  basePath: string;
  year: number;
  month: number;
  label: string;
  extraParams?: Record<string, string | undefined>;
}) {
  const href = (y: number, m: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(extraParams)) if (v) qs.set(k, v);
    qs.set("year", String(y));
    qs.set("month", String(m));
    return `${basePath}?${qs.toString()}`;
  };
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };

  return (
    <div className="inline-flex items-center rounded-xl border border-line bg-surface shadow-sm">
      <Link
        href={href(prev.y, prev.m)}
        aria-label="Previous month"
        className="grid size-10 place-items-center rounded-l-xl text-ink-soft hover:bg-brand-50 hover:text-brand-800"
      >
        <Icon name="chevron-left" className="size-4" />
      </Link>
      <span className="min-w-36 px-3 text-center text-sm font-semibold text-ink">{label}</span>
      <Link
        href={href(next.y, next.m)}
        aria-label="Next month"
        className="grid size-10 place-items-center rounded-r-xl text-ink-soft hover:bg-brand-50 hover:text-brand-800"
      >
        <Icon name="chevron-right" className="size-4" />
      </Link>
    </div>
  );
}

export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "error" | "success";
  children: ReactNode;
}) {
  const styles = {
    info: "border-sky-200 bg-sky-50 text-sky-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-rose-200 bg-rose-50 text-rose-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  const icon: IconName = { info: "info", warning: "warning", error: "error", success: "check" }[tone] as IconName;
  return (
    <div className={cx("flex gap-3 rounded-xl border px-4 py-3 text-sm", styles)} role={tone === "error" ? "alert" : undefined}>
      <Icon name={icon} className="mt-0.5 size-4" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
