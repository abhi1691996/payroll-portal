import { PrismaClient } from "@prisma/client";

/**
 * The RAW Prisma client. It performs no tenant scoping.
 *
 * Do not import this anywhere except src/server/tenancy and one-off scripts — ESLint enforces it.
 * Application code must go through `withTenant()` (tenant work) or `withPlatform()` (login and
 * Super Admin work) from "@/server/tenancy/db".
 */
const globalForPrisma = globalThis as unknown as {
  basePrisma: PrismaClient | undefined;
};

export const basePrisma = globalForPrisma.basePrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.basePrisma = basePrisma;
}
