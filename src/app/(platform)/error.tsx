"use client";

import { useEffect } from "react";
import { buttonClass } from "@/components/ui";

/** See src/app/(dashboard)/error.tsx — same idea, for the platform (Super Admin) side. */
export default function PlatformError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
        <a href="/platform" className={buttonClass("secondary")}>
          Back to platform dashboard
        </a>
      </div>
    </div>
  );
}
