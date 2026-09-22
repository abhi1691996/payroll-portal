"use client";

import { useActionState } from "react";
import { Alert, TextInput, buttonClass } from "@/components/ui";
import { acceptInvitation, type AcceptState } from "./actions";

export function AcceptForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInvitation.bind(null, token), {});

  return (
    <form action={action} className="mt-6 space-y-4">
      {state.error && <Alert tone="error">{state.error}</Alert>}
      <TextInput label="Choose a password" name="password" type="password" required hint="At least 8 characters, with a letter and a number." />
      <TextInput label="Confirm password" name="confirm" type="password" required />
      <button type="submit" disabled={pending} className={`${buttonClass("primary")} w-full`}>
        {pending ? "Saving…" : "Set password and continue"}
      </button>
    </form>
  );
}
