"use client";

import { useEffect } from "react";
import { buttonClass } from "@/components/ui";

/**
 * Catches anything that throws while rendering a page or running a Server Action in this section,
 * instead of the generic "This page couldn't load" Next.js gives by default. `error.message` is safe to
 * show here: every thrown Error in this codebase is a message written for the person using the app
 * (validation failures, "not found", business-rule messages) — never a raw stack trace or secret.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-rose-50 text-rose-600">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-6">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-8.18 14.18A2 2 0 0 0 3.93 21h16.14a2 2 0 0 0 1.82-2.96L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        </svg>
      </div>
      <h1 className="text-lg font-semibold text-ink">Something went wrong</h1>
      <p className="mt-2 text-sm text-ink-soft">{error.message || "An unexpected error occurred."}</p>
      {error.digest && <p className="mt-1 text-xs text-ink-muted">Reference: {error.digest}</p>}
      <div className="mt-6 flex justify-center gap-3">
        <button onClick={reset} className={buttonClass("primary")}>
          Try again
        </button>
        <a href="/dashboard" className={buttonClass("secondary")}>
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
