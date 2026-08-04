import { defineConfig } from "@playwright/test";

// Mirrors apps/kds-web/playwright.config.ts. Dev port 3003 matches
// apps/crew-web/package.json so a stray dev server doesn't get steamrolled.
// Next 16 dev gates HMR + hydration on `allowedDevOrigins`; the simplest way to
// keep the test driver origin (`localhost`) on the safe list is to hit it by
// name. 127.0.0.1 trips the cross-origin guard.
const port = Number(process.env.CREW_E2E_PORT ?? 3003);

export default defineConfig({
  testDir: "./e2e",
  timeout: process.env.CI ? 60_000 : 30_000,
  use: {
    baseURL: `http://localhost:${port}`,
    // Opt-in: point at a preinstalled Chromium (e.g. a sandbox that can't download
    // Playwright's bundled build). Unset in CI → Playwright uses its own browser.
    ...(process.env.PW_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
      : {})
  },
  webServer: {
    command: `pnpm --filter @rop/crew-web exec next dev --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI
  }
});
