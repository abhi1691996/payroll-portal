import { DefaultSession } from "next-auth";

/**
 * The session/JWT carries IDENTITY only. Roles and permissions are deliberately not stored here:
 * they are loaded from the database on every request (src/server/rbac/guard.ts) so changes and
 * revocations apply immediately. `superAdmin` exists only so the proxy can route the right portal.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      superAdmin: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    superAdmin?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    superAdmin?: boolean;
  }
}
