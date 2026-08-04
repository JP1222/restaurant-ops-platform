import { defineConfig } from "vitest/config";

// Integration suite: real ephemeral Postgres via Testcontainers, migrated by
// analytics-api's own raw-SQL runner. Separate from the default unit config so
// `pnpm test` stays fast + Docker-free; runs under `pnpm test:integration`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
