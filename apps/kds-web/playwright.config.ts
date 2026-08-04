import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_E2E_PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: `http://127.0.0.1:${port}`
  },
  webServer: {
    command: `pnpm --filter @rop/kds-web exec next dev --port ${port}`,
    port,
    reuseExistingServer: true,
    env: {
      // Per-spec auth bypass (opt-in via cookie). See src/lib/server-auth.ts.
      // The existing redirect-asserting specs don't set the cookie, so they
      // keep exercising the real auth gate.
      KDS_E2E_AUTH_BYPASS: "true"
    }
  }
});
