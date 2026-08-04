import { defineConfig } from "vitest/config";

// Integration suite: one ephemeral Postgres carrying both db-kds + db-auth
// (ADR-0015) plus an ephemeral Redis, via Testcontainers. Separate from the
// default unit config so `pnpm test` stays fast + Docker-free; runs under
// `pnpm test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    // The deployed app always has AI_TOKEN_ENCRYPTION_KEY; mirror it so the
    // at-rest encryption path (POS / Deliverect token ciphers) works against the
    // ephemeral DB. Fixed throwaway 32-byte hex — never a real key.
    env: {
      AI_TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
