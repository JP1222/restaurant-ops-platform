import { defineConfig } from "@playwright/test";

const port = Number(process.env.BACKOFFICE_E2E_PORT ?? 3001);

export default defineConfig({
  testDir: "./e2e",
  timeout: process.env.CI ? 60_000 : 30_000,
  workers: process.env.CI ? 2 : undefined,
  // E2E flake mitigation. The webServer runs `next dev --webpack` (below), which
  // compiles each route lazily on first hit. On a loaded self-hosted runner that
  // *cold* compile of a heavy Backoffice route (charts / mermaid / AI bundle —
  // this is the suite's heaviest app, 41 routes) delays both first paint and
  // client hydration, producing two distinct flake faces:
  //   A. a `toBeVisible` that overruns the default 5s assertion budget while the
  //      route is still compiling (whichever route is slowest that run is the one
  //      that flakes — hence a different spec fails each run), and
  //   B. a controlled-input `fill` that lands before React hydrates: the keystroke
  //      has no listener yet, hydration then resets the input to its ("") React
  //      state, and a button gated on that value never enables (no timeout helps).
  // The clean fix — a precompiled prod server (`next start`) — is out: it runs
  // NODE_ENV=production, which disables the proxy.ts auth bypass (deliberately
  // gated on NODE_ENV !== "production"), and we won't weaken that prod-safety
  // guard for a CI timing issue. Both faces are purely cold-compile artifacts of
  // `next dev` (warm routes are stable), so instead:
  //   (1) a larger CI assertion budget absorbs the paint case (A), and
  //   (2) one CI retry covers the hydration case (B) — the route is already
  //       compiled (warm) on the retry, so the re-run passes.
  // Both are CI-only; locally the dev server is warm via reuseExistingServer, so
  // a real failure still fails fast at 5s with no retry. Retried tests still
  // surface as "flaky" in the report — this tolerates the dev-server cold-compile
  // artifact without hiding a genuine product regression.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`
  },
  webServer: {
    command: `pnpm --filter @rop/backoffice-web exec next dev -p ${port} --webpack`,
    port,
    reuseExistingServer: !process.env.CI,
    env: {
      BACKOFFICE_E2E_AUTH_BYPASS: "true",
      // getServerEnv() (lib/env.ts) hard-requires these two — without them EVERY
      // analytics/ops/inventory BFF route throws "Invalid backoffice-web server env"
      // and 500s, spamming the e2e webServer log. The e2e specs mock the BFF
      // (route.fulfill), so real values are never needed; supply dummies that parse
      // (token .min(1), url .url()). The URL points at a dead port so any un-mocked
      // route fails fast instead of hanging.
      ANALYTICS_ADMIN_TOKEN: "e2e-dummy-analytics-token",
      INTERNAL_ANALYTICS_API_URL: "http://127.0.0.1:9"
    }
  }
});
