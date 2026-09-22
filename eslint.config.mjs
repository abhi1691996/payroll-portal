import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // Tenant isolation: application code must never touch the raw, unscoped Prisma client.
  // Use withTenant() / withPlatform() from "@/server/tenancy/db" instead.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/tenancy/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/tenancy/base-client", "@/server/tenancy/base-client"],
              message:
                "Don't use the raw Prisma client. Use withTenant() (company work) or withPlatform() (login / Super Admin) from @/server/tenancy/db.",
            },
          ],
        },
      ],
    },
  },
  // Files that legitimately need the raw client: DB-level tests and one-off scripts.
  {
    files: ["tests/**", "scripts/**", "prisma/**"],
    rules: { "no-restricted-imports": "off" },
  },
]);

export default eslintConfig;
