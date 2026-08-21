import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The Playwright smoke suite lives in tests/e2e and runs under `pnpm test:e2e`.
    exclude: ["tests/e2e/**", "node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
