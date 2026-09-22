import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import { fileURLToPath } from "node:url";

// Integration tests run against a throwaway Postgres database (payroll_test) that global-setup drops
// and recreates on every run, so they never touch development data.
const env = loadEnv("", process.cwd(), "");
const toTestDb = (url: string | undefined) => (url ?? "").replace(/\/[^/?]+(\?|$)/, "/payroll_test$1");

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.int.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One file at a time: they share one database.
    fileParallelism: false,
    env: {
      DATABASE_URL: toTestDb(env.DATABASE_URL),
      DIRECT_URL: toTestDb(env.DIRECT_URL),
    },
  },
});
