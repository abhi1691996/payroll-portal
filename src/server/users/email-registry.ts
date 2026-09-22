import { withPlatform } from "@/server/tenancy/db";

/**
 * Login emails are unique across the whole platform (one login = one company). A tenant cannot query
 * other companies' users, so uniqueness pre-checks go through this narrow platform helper. It
 * returns only WHICH of the given emails are taken — never who owns them or in which company.
 */
export async function findTakenEmails(emails: string[]): Promise<Set<string>> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return new Set();
  const rows = await withPlatform((db) =>
    db.user.findMany({ where: { email: { in: unique } }, select: { email: true } })
  );
  return new Set(rows.map((r) => r.email.toLowerCase()));
}
