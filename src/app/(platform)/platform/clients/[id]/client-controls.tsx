"use client";

import { useActionState, useTransition } from "react";
import { CopyField } from "@/components/copy-field";
import { Alert, buttonClass } from "@/components/ui";
import { reissueAdminInvite, setClientStatus } from "../actions";
import { INITIAL_CLIENT_STATE } from "../state";

export function StatusControl({ companyId, status, name }: { companyId: string; status: string; name: string }) {
  const [pending, start] = useTransition();
  const suspend = status !== "SUSPENDED";

  return (
    <button
      type="button"
      disabled={pending}
      className={buttonClass(suspend ? "danger" : "primary", "md")}
      onClick={() => {
        const message = suspend
          ? `Suspend ${name}?\n\nEveryone in this company — admin and employees — will be signed out and unable to log in until you activate it again. No data is deleted.`
          : `Activate ${name}? Their users will be able to sign in again.`;
        if (window.confirm(message)) start(() => setClientStatus(companyId, suspend ? "SUSPENDED" : "ACTIVE"));
      }}
    >
      {pending ? "Working…" : suspend ? "Suspend client" : "Activate client"}
    </button>
  );
}

export function ReissueInvite({ companyId }: { companyId: string }) {
  const [state, action, pending] = useActionState(() => reissueAdminInvite(companyId), INITIAL_CLIENT_STATE);

  return (
    <div className="space-y-3">
      <form action={action}>
        <button type="submit" disabled={pending} className={buttonClass("secondary")}>
          {pending ? "Creating…" : "Create a new invitation link"}
        </button>
      </form>
      {state.status === "error" && <Alert tone="error">{state.message}</Alert>}
      {state.status === "created" && (
        <div className="space-y-2">
          <CopyField value={state.inviteLink!} label="New invitation link" />
          <p className="text-xs text-ink-muted">
            Shown once and valid for {state.expiresInDays} days. Any earlier link stopped working.
          </p>
        </div>
      )}
    </div>
  );
}
