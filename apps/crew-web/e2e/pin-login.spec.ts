import { expect, test, type Page } from "@playwright/test";

// crew-web is a Floor prototype: the browser only ever talks to its own BFF
// routes under /api/*. Those handlers proxy to apps/inventory-api, which we do
// NOT want to require for e2e. Mocking at the BFF boundary keeps the test
// hermetic AND exercises the same fetch wrappers a real cook hits.

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

const EMPTY_INVENTORY = {
  items: [],
  categories: [],
  pos: [],
  waste_reasons: [],
  waste_settings: { photo_required_over_cents: 5000, manager_approval_over_cents: 10000 }
};

async function stubCrewBff(page: Page): Promise<void> {
  // /api/crew/me first — on mount the app calls this before rendering the
  // keypad. Returning 401 puts us in the unauthenticated branch (PinLogin).
  await page.route("**/api/crew/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauthorized" })
    })
  );
  // PIN submit — only `123456` is accepted, mirroring the demo fixture in
  // apps/crew-web/AGENTS.md. Anything else returns 401 like the real BFF.
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
  // After login the app immediately fetches the catalog. An empty payload is
  // enough to clear the loading screen and reveal the 3 home tiles.
  await page.route("**/api/inventory", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY_INVENTORY)
    })
  );
}

test.describe("crew-web PIN login", () => {
  test("keypad renders ES-first on first load", async ({ page }) => {
    await stubCrewBff(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Hola, identifícate" })).toBeVisible();
    await expect(page.getByText("Ingresa tu PIN de 6 dígitos")).toBeVisible();
    // The 0-9 keypad: smoke-check a couple of buttons exist.
    await expect(page.getByRole("button", { name: "1", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "0", exact: true })).toBeVisible();
  });

  test("valid PIN 123456 lands on the regrouped home", async ({ page }) => {
    await stubCrewBff(page);
    await page.goto("/");
    for (const digit of ["1", "2", "3", "4", "5", "6"]) {
      await page.getByRole("button", { name: digit, exact: true }).click();
    }
    // The MOVIMIENTOS group label proves we transitioned out of the keypad onto
    // the regrouped home (design handoff). The greeting "Hola, Maya" and the
    // top-bar pill both contain "Maya", so we assert the unambiguous group label.
    await expect(page.getByText("Movimientos")).toBeVisible();
    await expect(page.getByRole("button", { name: /MR Maya Salir/ })).toBeVisible();
    // The headline scan tile + the three Movimientos tiles + the Artículos
    // catalog tile — the entry points to every Floor action.
    await expect(page.getByRole("button", { name: /Escanear factura/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Recibir/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Merma/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reconteo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Artículos/ })).toBeVisible();
  });

  test("wrong PIN surfaces the error and clears the pad", async ({ page }) => {
    await stubCrewBff(page);
    await page.goto("/");
    for (const digit of ["9", "9", "9", "9", "9", "9"]) {
      await page.getByRole("button", { name: digit, exact: true }).click();
    }
    await expect(page.getByText("PIN incorrecto, intenta de nuevo")).toBeVisible();
    // The pad clears 600ms after a wrong PIN — verify we end up back on the
    // keypad and the error fades.
    await expect(page.getByText("PIN incorrecto, intenta de nuevo")).toBeHidden({ timeout: 2000 });
    await expect(page.getByRole("heading", { name: "Hola, identifícate" })).toBeVisible();
  });
});
