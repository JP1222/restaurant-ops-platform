import { expect, test, type Page, type Request } from "@playwright/test";

// crew-web e2e — Escanear código (barcode stock-adjust, design handoff §8 / ADR-0737).
//
// scan-barcode-flow.tsx: a cook scans an item's barcode (BarcodeScanner) → it resolves via
// the BFF route /api/inventory/barcode/:code → a "found" card with a SIGNED stepper → Agregar
// / Restar writes an absolute one-item recount through /api/inventory/counts (target = on_hand
// + delta × pack-base). A live camera can't run in headless CI and the wasm decoder can't read
// a blank stream, so BarcodeScanner exposes a guarded `window.__E2E_BARCODE__` seam (never set
// in production) to inject a decoded code; we mock the resolve + count at the BFF boundary and
// assert the count payload — the contract that actually moves stock. (Playwright's 1280x720
// viewport makes useCrewSize() report desktop.)

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

// on_hand 12; an item-level barcode (pack null) ⇒ the stepper is in base units, so +3 → 15.
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

const UPC = "012345678905";

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

test.describe("crew-web barcode stock-adjust", () => {
  test("scan → +3 posts an absolute recount of on_hand + delta", async ({ page }) => {
    await stubCrewBff(page);
    // Inject the decoded code at the first BarcodeScanner mount; also fail getUserMedia so the
    // post-write camera re-arm (flag already consumed) resolves deterministically, not via a
    // real camera that doesn't exist in CI.
    await page.addInitScript((code) => {
      (window as unknown as { __E2E_BARCODE__?: string }).__E2E_BARCODE__ = code;
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(Object.assign(new Error("no camera"), { name: "NotFoundError" }));
      }
    }, UPC);
    // resolveBarcode → item-level code (pack null), so the stepper is in base units.
    await page.route("**/api/inventory/barcode/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: CHICKEN, pack: null })
      })
    );

    let countBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/counts", async (route, request) => {
      countBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const countReq = page.waitForRequest(
      (r: Request) => r.url().includes("/api/inventory/counts") && r.method() === "POST"
    );

    await loginMaya(page);

    await page.getByRole("button", { name: /Escanear código/ }).click();

    // The seam fires onDetect → resolve → "found" card with the resolved item.
    await expect(page.getByText("Artículo encontrado")).toBeVisible();
    await expect(page.getByText("Chicken Thigh")).toBeVisible();

    // +3 via the signed stepper (its aria-label is exactly "Agregar"; the apply button's
    // accessible name carries the qty, so it never collides with this exact match).
    const plus = page.getByRole("button", { name: "Agregar", exact: true });
    await plus.click();
    await plus.click();
    await plus.click();
    await expect(page.getByText("+3", { exact: true })).toBeVisible();

    // Apply: target = 12 + 3 = 15 (pack null ⇒ base units, scope "Scan barcode").
    await page.getByRole("button", { name: /Agregar.*3/ }).click();

    await countReq;
    expect(countBody).toEqual({
      updates: { "sku-001": 15 },
      scope: "Scan barcode",
      idempotency_key: expect.any(String)
    });
  });

  test("camera unavailable shows the denied prompt and returns home", async ({ page }) => {
    await stubCrewBff(page);
    // No injection seam; force getUserMedia to reject like a denied permission.
    await page.addInitScript(() => {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
      }
    });

    await loginMaya(page);
    await page.getByRole("button", { name: /Escanear código/ }).click();

    await expect(page.getByText("Permite el acceso a la cámara para escanear")).toBeVisible();
    // "Escribir código" closes the scanner back to Home (no manual-entry stage in this flow).
    await page.getByRole("button", { name: "Escribir código" }).click();
    await expect(page.getByText("Movimientos")).toBeVisible();
  });
});
