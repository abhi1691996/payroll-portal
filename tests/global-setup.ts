import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "vite";

const env = loadEnv("", process.cwd(), "");
const toTestDb = (url: string) => url.replace(/\/[^/?]+(\?|$)/, "/payroll_test$1");

/** Drops and recreates payroll_test, applies every migration, and seeds the platform catalogue. */
export default async function setup() {
  const ownerUrl = env.DIRECT_URL;
  if (!ownerUrl) throw new Error("DIRECT_URL is not set (see .env.example)");
  const testOwner = toTestDb(ownerUrl);
  const testApp = toTestDb(env.DATABASE_URL);

  const admin = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS "payroll_test" WITH (FORCE)');
    await admin.$executeRawUnsafe('CREATE DATABASE "payroll_test"');
  } finally {
    await admin.$disconnect();
  }

  const childEnv = { ...process.env, DIRECT_URL: testOwner, DATABASE_URL: testApp };
  execSync("npx prisma migrate deploy", { env: childEnv, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { env: childEnv, stdio: "pipe" });
}
