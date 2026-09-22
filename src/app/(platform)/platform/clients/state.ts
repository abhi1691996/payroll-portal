/** Result of a client Server Action, returned to the form. Plain data only. */
export interface ClientActionState {
  status: "idle" | "created" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  companyId?: string;
  companyName?: string;
  adminEmail?: string;
  /** Shown once: only a hash of the token is stored, so it cannot be shown again. */
  inviteLink?: string;
  expiresInDays?: number;
}

export const INITIAL_CLIENT_STATE: ClientActionState = { status: "idle" };
