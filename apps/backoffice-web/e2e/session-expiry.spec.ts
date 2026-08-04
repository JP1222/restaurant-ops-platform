import { expect, test, type Page } from "@playwright/test";

// Closes #213 — session expiry mid-action redirects to login.
//
// proxy.ts is supposed to 401 (JSON) protected /api/* calls and redirect
// protected *page* loads to /login?from=<path> once the session is gone. We
// prove both: (1) a save that fires after the session cookie is cleared gets a
// 401 -> the optimistic edit rolls back and an error toast surfaces; (2)
// navigating to a protected page with no session redirects to /login carrying
// the return path.

interface SettingRow {
  key: string;
  category: "ai";
  value: unknown;
  source: "default";
  description: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

const SETTINGS: SettingRow[] = [
  {
    key: "ai.thinking_mode",
    category: "ai",
    value: false,
    source: "default",
    description: "Enable DeepSeek's chain-of-thought reasoning.",
    updatedAt: null,
    updatedBy: null,
  },
];

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "127.0.0.1", path: "/" },
  ]);
}

test("a save after the session is cleared rolls back and surfaces an error", async ({ page }) => {
  await bypassAuth(page);

  // GET is stubbed so the form renders. PUT is allowed to hit the real proxy —
  // once the bypass cookie is gone, the proxy answers 401 (no session).
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ settings: SETTINGS }),
      });
    }
    return route.continue();
  });

  await page.goto("/settings/ai");
  const toggle = page.getByRole("switch", { name: "Thinking mode" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // Session expires mid-edit.
  await page.context().clearCookies();

  // Synchronize on the proxy's actual 401 instead of racing a fixed timeout
  // from the click: under `next dev` the PUT route compiles on first hit, so
  // the round-trip can exceed the default expect timeout under CI load — the
  // source of this spec's flakiness. Once the 401 lands, onError reverts the
  // optimistic edit and surfaces the error synchronously.
  const putRejected = page.waitForResponse(
    (res) => res.url().includes("/api/settings") && res.request().method() === "PUT",
  );
  await toggle.click();
  expect((await putRejected).status()).toBe(401);

  // The optimistic flip is reverted and the failure is surfaced via an error
  // toast ("Couldn't save — change reverted").
  await expect(page.getByText(/couldn't save/i).first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("navigating to a protected page with no session redirects to /login", async ({ page }) => {
  await bypassAuth(page);
  await page.goto("/settings/ai");
  await expect(page.getByRole("switch", { name: "Thinking mode" }).or(page.getByText(/settings/i)).first()).toBeVisible();

  // Drop the session, then try to open another protected page directly.
  await page.context().clearCookies();
  await page.goto("/ops");

  await expect(page).toHaveURL(/\/login\?from=%2Fops$/);
  await expect(page.getByRole("heading", { name: /sign in to backoffice/i })).toBeVisible();
});
