import { expect, test, type Page, type Request } from "@playwright/test";

// crew-web e2e — Reconteo flow (rebuilt to the design handoff's variance grid).
//
// recount-flow.tsx: every item shows its system count + an actual-count input; a
// variance badge shows the diff; Guardar conteo commits the changed lines via the
// BFF route /api/inventory/counts (forwarded to inventory-api in prod). A broken
// submit lets the running count drift, so subsequent waste/86 calls go wrong.
// Mocked at the BFF boundary like pin-login.spec.ts.

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

// Known on_hand of 12. Entering 9 is a −3 variance the badge surfaces.
const CHICKEN = {
  id: "sku-001",
  sku: "CHK-THIGH",
  name: "Chicken Thigh",
  category: "food",
  unit: "case",
  on_hand: 12,
  par_min: 4,
  par_max: 20,
  cost_cents: 80,
  purchase_unit: "Case",
  pack_qty: 1,
  purchase_cost_cents: 80,
  vendor: "US Foods",
  shelf_days: 5,
  last_counted: "2026-05-27",
  flagged_86: false
};

const INVENTORY = {
  items: [CHICKEN],
  categories: [{ id: "food", name: "Proteína", color: "#ef4444" }],
  pos: [],
  waste_reasons: [],
  waste_settings: { photo_required_over_cents: 5000, manager_approval_over_cents: 10000 }
};

async function stubCrewBff(page: Page): Promise<void> {
  await page.route("**/api/crew/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauthorized" })
    })
  );
  await page.route("**/api/crew/login", async (route, request) => {
    let pin: unknown;
    try {
      pin = (request.postDataJSON() as { pin?: unknown })?.pin;
    } catch {
      pin = undefined;
    }
    if (pin === "123456") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ employee: MAYA })
      });
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "invalid" })
    });
  });
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(INVENTORY)
    })
  );
}

async function loginMaya(page: Page): Promise<void> {
  await page.goto("/");
  for (const digit of ["1", "2", "3", "4", "5", "6"]) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect(page.getByText("Movimientos")).toBeVisible();
}

test.describe("crew-web recount", () => {
  test("typing a below-system count shows the variance badge and posts the delta", async ({
    page
  }) => {
    await stubCrewBff(page);

    let countBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/counts", async (route, request) => {
      countBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const countReq = page.waitForRequest(
      (r: Request) => r.url().includes("/api/inventory/counts") && r.method() === "POST"
    );

    await loginMaya(page);

    await page.getByRole("button", { name: /Reconteo/ }).click();
    await expect(page.getByRole("heading", { name: "Reconteo" })).toBeVisible();
    await expect(page.getByText(/Sistema: 12 case/)).toBeVisible();

    // The single count input (the search box is a textbox, this is a spinbutton).
    await page.getByRole("spinbutton").fill("9");
    // Variance badge surfaces the −3 delta (desktop viewport shows it).
    await expect(page.getByText("-3", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Guardar conteo/ }).click();
    await expect(page.getByRole("heading", { name: "¡Conteo guardado!" })).toBeVisible();

    // Round-trip: applyCount posts { updates: { [item.id]: qty }, scope } + a
    // client idempotency_key — assert presence/type without pinning the UUID.
    await countReq;
    expect(countBody).toEqual({
      updates: { "sku-001": 9 },
      scope: "Recount",
      idempotency_key: expect.any(String)
    });
  });

  test("a count matching the system leaves nothing to save", async ({ page }) => {
    await stubCrewBff(page);
    await page.route("**/api/inventory/counts", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    await loginMaya(page);

    await page.getByRole("button", { name: /Reconteo/ }).click();
    await page.getByRole("spinbutton").fill("12");
    // No variance badge, and the footer counts 0 changed lines (disabled).
    await expect(page.getByText("-0", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Guardar conteo \(0\)/ })).toBeDisabled();
  });
});
