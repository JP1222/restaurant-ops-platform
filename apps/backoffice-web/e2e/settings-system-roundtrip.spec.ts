import { expect, test, type Page } from "@playwright/test";

// Closes #168 — /settings/system save + reload round-trip.
//
// /settings/system is a back-compat redirect to /settings/ai (the live AppSetting
// editor). The panel auto-saves per field: PUT /api/settings then invalidates and
// re-reads GET /api/settings. This stub holds server-side state so a toggle
// survives a full page reload, and exercises the inline zod-range validation on a
// numeric field.

interface SettingRow {
  key: string;
  category: "ai" | "secret";
  value: unknown;
  source: "db" | "env" | "default";
  description: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

function buildState(): SettingRow[] {
  return [
    {
      key: "ai.thinking_mode",
      category: "ai",
      value: false,
      // "default" (not "db") so the only "Saved" text on the page is the
      // transient StatusPill the save produces, not a per-row source badge.
      source: "default",
      description: "Enable DeepSeek's chain-of-thought reasoning.",
      updatedAt: null,
      updatedBy: null,
    },
    {
      key: "ai.max_output_tokens",
      category: "ai",
      value: 4000,
      source: "default",
      description: "Hard cap on tokens emitted per assistant turn.",
      updatedAt: null,
      updatedBy: null,
    },
  ];
}

// Stateful stub: PUT mutates the in-memory rows so the follow-up GET (from the
// query invalidation OR a page reload) reflects the new value.
async function stubSettings(page: Page, state: SettingRow[]) {
  await page.route("**/api/settings", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = JSON.parse(request.postData() ?? "{}") as { key: string; value: unknown };
      const row = state.find((s) => s.key === body.key);
      if (row) {
        row.value = body.value;
        row.updatedAt = new Date().toISOString();
        row.updatedBy = "e2e";
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: state }),
    });
  });
}

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "127.0.0.1", path: "/" },
  ]);
}

test("toggling a boolean setting saves and survives a page reload", async ({ page }) => {
  await bypassAuth(page);
  const state = buildState();
  await stubSettings(page, state);

  await page.goto("/settings/ai");

  const toggle = page.getByRole("switch", { name: "Thinking mode" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  const savePut = page.waitForRequest(
    (req) => req.url().includes("/api/settings") && req.method() === "PUT",
  );
  await toggle.click();
  const putBody = JSON.parse((await savePut).postData() ?? "{}");
  expect(putBody).toMatchObject({ key: "ai.thinking_mode", value: true });

  // Inline save lifecycle: the per-field StatusPill confirms the write.
  await expect(page.getByText("Saved")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // The server state was mutated by the PUT, so a fresh load still shows ON.
  await page.reload();
  const toggleAfter = page.getByRole("switch", { name: "Thinking mode" });
  await expect(toggleAfter).toHaveAttribute("aria-checked", "true");
});

test("an out-of-range numeric setting surfaces an inline validation error", async ({ page }) => {
  await bypassAuth(page);
  const state = buildState();
  await stubSettings(page, state);

  await page.goto("/settings/ai");

  const tokens = page.getByLabel("Max output tokens");
  await expect(tokens).toBeVisible();

  // Min is 100 — typing 50 and committing must flag the field, not silently snap.
  await tokens.fill("50");
  await tokens.blur();

  await expect(page.getByText(/Enter a number between 100 and 32,000/i)).toBeVisible();
  await expect(tokens).toHaveAttribute("aria-invalid", "true");
});
