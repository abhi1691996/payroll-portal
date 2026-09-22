import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Fast unit tests: no database. Integration tests run via `npm run test:int` (vitest.int.config.ts).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.int.test.ts", "node_modules/**"],
  },
});
