/** ₹1,20,000 style (Indian digit grouping). Accepts Prisma Decimals via Number(). */
export function inr(value: number | string | { toString(): string }, fractionDigits = 0): string {
  const n = Number(value);
  return `₹${n.toLocaleString("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/** ₹12.4L / ₹1.2Cr for tight spaces such as stat cards. */
export function inrCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `₹${(value / 1e7).toFixed(2).replace(/\.?0+$/, "")}Cr`;
  if (abs >= 1e5) return `₹${(value / 1e5).toFixed(2).replace(/\.?0+$/, "")}L`;
  return inr(value);
}

/**
 * Pure calendar dates are stored as UTC midnight throughout the app, so format them in UTC —
 * otherwise a server in a western timezone would show the previous day.
 */
export function fmtDate(date: Date, style: "short" | "long" = "short"): string {
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(style === "long" ? { month: "long" } : {}),
    timeZone: "UTC",
  });
}

export function initials(first: string, last: string): string {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}
