"use client";

import { useState } from "react";
import { Icon } from "./icons";
import { buttonClass, inputClass } from "./ui";

/** Read-only value with a one-click copy button (used for invite links). */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API can be blocked (non-secure origin): fall back to selecting the text.
      const el = document.getElementById("copy-field-input") as HTMLInputElement | null;
      el?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex gap-2">
      <input
        id="copy-field-input"
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className={`${inputClass} font-mono text-xs`}
      />
      <button type="button" onClick={copy} className={buttonClass("primary")}>
        <Icon name={copied ? "check" : "sheet"} className="size-4" />
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
