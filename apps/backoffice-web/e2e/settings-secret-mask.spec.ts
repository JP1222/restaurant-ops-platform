import { expect, test, type Page } from "@playwright/test";

const SECRET_KEY = "ai.deepseek_api_key";
const SECRET_PLAINTEXT = "sk-test-plaintext-revealed-value";

const listResponse = {
  settings: [
    {
      key: "ai.model_id",
      category: "ai",
      value: "deepseek-v4-pro",
      source: "db",
      description: "Model id.",
      updatedAt: null,
      updatedBy: null,
      version: 0,
    },
    {
      key: SECRET_KEY,
      category: "secret",
      value: null,
      source: "db",
      description: "DeepSeek API key.",
      updatedAt: null,
      updatedBy: null,
      version: 0,
      valuePresent: true,
    },
  ],
};

async function stub(page: Page) {
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        route.request().method() === "GET" ? listResponse : { ok: true },
      ),
    }),
  );
  await page.route(`**/api/settings/${encodeURIComponent(SECRET_KEY)}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ key: SECRET_KEY, value: SECRET_PLAINTEXT }),
    }),
  );
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "127.0.0.1", path: "/" },
  ]);
}

test("secret AppSetting row masks by default, reveals on click, re-masks after 30s", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/settings/ai");

  const input = page.getByLabel(`${SECRET_KEY} value (masked)`);
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("●●●●●●●●");

  // Install the synthetic clock AFTER the initial fetch settles so React
  // Query's loading transitions aren't frozen at boot.
  await page.clock.install();

  await page.getByRole("button", { name: `Reveal ${SECRET_KEY}` }).click();
  await expect(input).toHaveValue(SECRET_PLAINTEXT);

  await page.clock.fastForward("00:31");
  await expect(input).toHaveValue("●●●●●●●●");
});
