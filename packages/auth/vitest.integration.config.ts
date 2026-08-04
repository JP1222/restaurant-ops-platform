import { defineConfig } from "vitest/config";

// Integration suite: real ephemeral db-auth Postgres via Testcontainers (see
// tests/integration/fixture.ts). Separate from the default unit config so
// `pnpm test` stays fast + Docker-free; runs under `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
