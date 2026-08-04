import { expect, test, type Page, type Request } from "@playwright/test";

// crew-web e2e — Merma flow (rebuilt to the design handoff's docked panel).
//
// waste-flow.tsx: a searchable item list; tapping an item docks a bottom panel
// (qty stepper + reason chips + Registrar merma) that POSTs to the BFF route
// /api/inventory/waste, which in prod forwards to apps/inventory-api. As with
// pin-login.spec.ts we mock at the BFF boundary: hermetic, no inventory-api, but
// still exercises the real fetch wrappers in lib/api.ts a cook hits.

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

// One cheap protein so 3 units stays well under the photo-required threshold
// (3 * 80c = $2.40 < $50.00), keeping the happy path a clean pick → reason → save.
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
  waste_reasons: [
    { id: "drop", label: "Se cayó", color: "#0ea5e9", needs_photo_over_cents: 5000 },
    { id: "spoilage", label: "Caducidad", color: "#16a34a", needs_photo_over_cents: 5000 }
  ],
  // photo_required_over_cents is high so a $2.40 waste never demands a photo.
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

test.describe("crew-web record waste", () => {
  test("docked waste submit posts the expected body and confirms (ES)", async ({ page }) => {
    await stubCrewBff(page);

    let wasteBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/waste", async (route, request) => {
      wasteBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const wasteReq = page.waitForRequest(
      (r: Request) => r.url().includes("/api/inventory/waste") && r.method() === "POST"
    );

    await loginMaya(page);

    await page.getByRole("button", { name: /Merma/ }).click();
    await expect(page.getByRole("heading", { name: "Merma" })).toBeVisible();
    // Tap the item → the bottom panel docks.
    await page.getByRole("button", { name: /Chicken Thigh/ }).click();
    // Set qty to 3 (the docked qty stepper is the only spinbutton; search is a textbox).
    await page.getByRole("spinbutton").fill("3");
    // Pick a reason, then log.
    await page.getByRole("button", { name: /Se cayó/ }).click();
    await page.getByRole("button", { name: /Registrar merma/ }).click();

    await expect(page.getByRole("heading", { name: "¡Merma registrada!" })).toBeVisible();
    await expect(page.getByText(/Chicken Thigh/)).toBeVisible();

    // Round-trip: sku from item id, qty from the stepper, reason id, empty notes,
    // no photo, cost_cents = round(80 * 3) = 240, plus a client idempotency_key.
    await wasteReq;
    expect(wasteBody).toEqual({
      sku: "sku-001",
      qty: 3,
      reason: "drop",
      notes: "",
      photo: false,
      cost_cents: 240,
      idempotency_key: expect.any(String)
    });
  });

  test("confirmation copy renders in English when toggled to EN first", async ({ page }) => {
    await stubCrewBff(page);
    await page.route("**/api/inventory/waste", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    await loginMaya(page);

    // Flip to English on the home top-bar, then run the same flow — the EN strings
    // must carry through to the final confirmation (bilingual, no state loss).
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByText("Movements")).toBeVisible();

    await page.getByRole("button", { name: /Waste/ }).click();
    await page.getByRole("button", { name: /Chicken Thigh/ }).click();
    await page.getByRole("spinbutton").fill("3");
    await page.getByRole("button", { name: /Dropped/ }).click();
    await page.getByRole("button", { name: /Log waste/ }).click();

    await expect(page.getByRole("heading", { name: "Waste recorded!" })).toBeVisible();
  });

  test("re-tap after a failed save reuses the idempotency key (server dedups the retry)", async ({
    page
  }) => {
    await stubCrewBff(page);

    // First POST fails (server error), the retry succeeds. Capture every key so we can
    // assert the unchanged waste re-sent the SAME idempotency_key — the whole point of
    // hoisting it into the flow's confirm state (lib/use-idempotency-key.ts).
    const keys: unknown[] = [];
    let calls = 0;
    await page.route("**/api/inventory/waste", async (route, request) => {
      calls += 1;
      keys.push((request.postDataJSON() as Record<string, unknown>).idempotency_key);
      await route.fulfill({
        status: calls === 1 ? 500 : 200,
        contentType: "application/json",
        body: "{}"
      });
    });

    await loginMaya(page);

    await page.getByRole("button", { name: /Merma/ }).click();
    await page.getByRole("button", { name: /Chicken Thigh/ }).click();
    await page.getByRole("spinbutton").fill("3");
    await page.getByRole("button", { name: /Se cayó/ }).click();

    const submit = page.getByRole("button", { name: /Registrar merma/ });
    await submit.click();
    // First attempt reached the server and failed; the flow stays on the panel and
    // re-enables the button (busy cleared) so the cook can retry the same waste.
    await expect.poll(() => calls).toBe(1);
    await expect(page.getByRole("heading", { name: "¡Merma registrada!" })).toBeHidden();
    await expect(submit).toBeEnabled();

    await submit.click();
    await expect(page.getByRole("heading", { name: "¡Merma registrada!" })).toBeVisible();

    expect(calls).toBe(2);
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[1]).toBe(keys[0]);
  });

  test("returning to home after a save does not re-post the waste", async ({ page }) => {
    await stubCrewBff(page);

    let postCount = 0;
    await page.route("**/api/inventory/waste", async (route) => {
      postCount += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await loginMaya(page);

    await page.getByRole("button", { name: /Merma/ }).click();
    await page.getByRole("button", { name: /Chicken Thigh/ }).click();
    await page.getByRole("spinbutton").fill("3");
    await page.getByRole("button", { name: /Se cayó/ }).click();
    await page.getByRole("button", { name: /Registrar merma/ }).click();

    await expect(page.getByRole("heading", { name: "¡Merma registrada!" })).toBeVisible();

    // The terminal confirmation's only button is "Listo" (→ home); no path re-fires
    // the POST, so a second request would be a regression.
    await page.getByRole("button", { name: "Listo", exact: true }).click();
    await expect(page.getByText("Movimientos")).toBeVisible();
    expect(postCount).toBe(1);
  });
});
