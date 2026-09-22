import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { withPlatform } from "@/server/tenancy/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Vercel terminates TLS and proxies requests, so the Host header is theirs, not ours; without this
  // Auth.js refuses the request as an "untrusted host". Safe here because src/proxy.ts and every
  // Server Action re-check the real session/permissions themselves — nothing trusts the host alone.
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }

        // The tenant isn't known until we know who the user is, so this lookup runs with platform
        // privileges. It reads exactly one user by unique email.
        const user = await withPlatform((db) =>
          db.user.findUnique({
            where: { email: email.trim().toLowerCase() },
            include: { company: { select: { id: true, status: true } } },
          })
        );
        if (!user) return null;

        const passwordValid = await bcrypt.compare(password, user.passwordHash);
        if (!passwordValid) return null;

        // Invited (no password set yet) and disabled users cannot sign in; neither can anyone in a
        // suspended company. Same generic failure for all, so it can't be used to probe accounts.
        if (user.status !== "ACTIVE") return null;
        if (user.company?.status === "SUSPENDED") return null;

        await withPlatform(async (db) => {
          await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
          await db.auditLog.create({
            data: {
              companyId: user.companyId,
              actorUserId: user.id,
              actorEmail: user.email,
              module: "auth",
              action: "login",
            },
          });
        });

        return { id: user.id, email: user.email, superAdmin: user.platformRole === "SUPER_ADMIN" };
      },
    }),
  ],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.superAdmin = user.superAdmin ?? false;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user) {
        session.user.id = token.sub as string;
        session.user.superAdmin = Boolean(token.superAdmin);
      }
      return session;
    },
  },
});
