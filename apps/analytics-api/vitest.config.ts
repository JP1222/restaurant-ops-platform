import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests (real Postgres via Testcontainers) run under their own
    // config via `pnpm test:integration`; keep the unit run fast + Docker-free.
    exclude: [...configDefaults.exclude, "tests/integration/**"]
  }
});

