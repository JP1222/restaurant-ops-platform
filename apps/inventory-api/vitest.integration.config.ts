import { defineConfig } from "vitest/config";

// Integration suite: real ephemeral Postgres via Testcontainers (see
// tests/integration/fixture.ts). Kept separate from the default unit config so
// `pnpm test` stays fast and Docker-free; this runs under `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Container boot + `prisma migrate deploy` + seed is well under a minute, but
    // give cold Docker image pulls headroom on first run.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One container per file; let files run in parallel but cap fork churn.
    fileParallelism: true,
  },
});
