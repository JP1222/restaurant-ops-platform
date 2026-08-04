import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The deployed app always has AI_TOKEN_ENCRYPTION_KEY (host env / 1Password);
    // mirror that for unit tests so the at-rest encryption path (POS + Deliverect
    // token ciphers) exercises real AES-256-GCM instead of throwing on a missing
    // key. A fixed throwaway 32-byte hex — never a real key.
    env: {
      AI_TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    include: ["tests/**/*.test.ts"],
    // Integration tests (real Postgres + Redis via Testcontainers) run under
    // their own config via `pnpm test:integration`; keep the unit run fast +
    // Docker-free.
    exclude: [...configDefaults.exclude, "tests/integration/**"]
  }
});

