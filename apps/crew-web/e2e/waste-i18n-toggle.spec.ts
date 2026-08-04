import { expect, test, type Page } from "@playwright/test";

// crew-web e2e — ES/EN toggle mid-Merma-flow preserves dock state (issue #221).
//
// AGENTS.md design rule #6: "Spanish default, English toggle that doesn't lose
// state." `lang` lives in CrewApp and is passed down; the docked waste state
// (selected item, typed quantity, picked reason) lives inside WasteFlow, and the
// screen wrapper is keyed by `screen` only (not lang) — so toggling the language
// must NOT remount the flow or reset the dock.
//
// Mocked at the BFF boundary like pin-login.spec.ts; no inventory-api needed.

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

const SALMON = {
  id: "sku-004",
  sku: "SAL-FILET",
  name: "Salmon Filet",
  category: "food",
  unit: "case",
  on_hand: 20,
  par_min: 4,
  par_max: 24,
  cost_cents: 120,
  purchase_unit: "Case",
  pack_qty: 1,
  purchase_cost_cents: 120,
  vendor: "True World",
  shelf_days: 3,
  last_counted: "2026-05-27",
  flagged_86: false
};

const INVENTORY = {
  items: [SALMON],
  categories: [{ id: "food", name: "Proteína", color: "#ef4444" }],
  pos: [],
  waste_reasons: [{ id: "drop", label: "Se cayó", color: "#0ea5e9", needs_photo_over_cents: 5000 }],
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

function langButton(page: Page, code: "ES" | "EN") {
  return page.getByRole("button", { name: code, exact: true });
}

test.describe("crew-web waste i18n toggle", () => {
  test("toggling ES↔EN in the dock keeps item + quantity", async ({ page }) => {
    await stubCrewBff(page);
    await loginMaya(page);

    // Enter Merma (ES default), pick the salmon → the dock opens, set qty 5.
    await page.getByRole("button", { name: /Merma/ }).click();
    await page.getByRole("button", { name: /Salmon Filet/ }).click();
    await page.getByRole("spinbutton").fill("5");
    await expect(page.getByRole("spinbutton")).toHaveValue("5");

    // Toggle to English — strings flip…
    await langButton(page, "EN").click();
    await expect(page.getByRole("button", { name: /Log waste/ })).toBeVisible();
    // …and the dock state survives: same item, same typed quantity.
    await expect(page.getByText("Salmon Filet").first()).toBeVisible();
    await expect(page.getByRole("spinbutton")).toHaveValue("5");

    // Back to Spanish — same invariants the other direction.
    await langButton(page, "ES").click();
    await expect(page.getByRole("button", { name: /Registrar merma/ })).toBeVisible();
    await expect(page.getByRole("spinbutton")).toHaveValue("5");
  });

  test("toggling EN re-renders the picked reason without losing the selection", async ({
    page
  }) => {
    await stubCrewBff(page);
    await loginMaya(page);

    await page.getByRole("button", { name: /Merma/ }).click();
    await page.getByRole("button", { name: /Salmon Filet/ }).click();
    await page.getByRole("spinbutton").fill("5");
    await page.getByRole("button", { name: /Se cayó/ }).click();

    await langButton(page, "EN").click();
    // The reason chip re-renders in English…
    await expect(page.getByRole("button", { name: /Dropped/ })).toBeVisible();
    // …and the selection (+ qty) survived, so the log button is enabled.
    await expect(page.getByRole("spinbutton")).toHaveValue("5");
    await expect(page.getByRole("button", { name: /Log waste/ })).toBeEnabled();
  });
});
