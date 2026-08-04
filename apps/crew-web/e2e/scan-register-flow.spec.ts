import { expect, test, type Page, type Request } from "@playwright/test";

// crew-web e2e — Escanear para agregar (floor scan-to-register, barcode-onboarding ADR opened to
// the floor). A cook scans a UPC → the form pre-fills from the OFF public API → register creates
// the item + binds the barcode → an optional receive books stock. The live camera can't run in
// headless CI, so BarcodeScanner's guarded `window.__E2E_BARCODE__` seam injects a code; we mock
// lookup/create/pack/barcode/receive at the BFF boundary and assert the bind + receive payloads —
// the contracts that actually register and stock the item.

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

const INVENTORY = {
  items: [],
  categories: [{ id: "food", name: "Proteína", color: "#ef4444" }],
  pos: [],
  waste_reasons: [],
  waste_settings: { photo_required_over_cents: 5000, manager_approval_over_cents: 10000 }
};

const UPC = "0049000000443";
const PACK = { id: "pack-1", label: "Caja", base_qty_per_pack: 24, is_purchase_default: true };

function item(over: Record<string, unknown> = {}) {
  return {
    id: "sku-new",
    sku: "SKU-NEW",
    name: "Whole Milk",
    category: "food",
    unit: "gal",
    on_hand: 0,
    par_min: 0,
    par_max: 0,
    cost_cents: 0,
    purchase_unit: "",
    pack_qty: 1,
    purchase_cost_cents: 0,
    vendor: "",
    shelf_days: 999,
    last_counted: "2026-06-20",
    flagged_86: false,
    ...over
  };
}

async function stubCrewBff(page: Page): Promise<void> {
  await page.route("**/api/crew/me", (r) =>
    r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) })
  );
  await page.route("**/api/crew/login", async (route, request) => {
    let pin: unknown;
    try {
      pin = (request.postDataJSON() as { pin?: unknown })?.pin;
    } catch {
      pin = undefined;
    }
    await route.fulfill(
      pin === "123456"
        ? { status: 200, contentType: "application/json", body: JSON.stringify({ employee: MAYA }) }
        : { status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid" }) }
    );
  });
  await page.route("**/api/inventory", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVENTORY) })
  );
}

async function loginMaya(page: Page): Promise<void> {
  await page.goto("/");
  for (const d of ["1", "2", "3", "4", "5", "6"]) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  await expect(page.getByText("Movimientos")).toBeVisible();
}

test.describe("crew-web floor scan-to-register", () => {
  test("scan unknown UPC → OFF prefill → register binds the barcode → receive books stock", async ({ page }) => {
    await stubCrewBff(page);
    // Inject the decoded code at the first camera mount; fail getUserMedia so the post-receive
    // re-arm resolves deterministically (no real camera in CI).
    await page.addInitScript((code) => {
      (window as unknown as { __E2E_BARCODE__?: string }).__E2E_BARCODE__ = code;
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(Object.assign(new Error("no cam"), { name: "NotFoundError" }));
      }
    }, UPC);

    // Enrichment lookup: unknown code WITH OFF auto-fill suggestions.
    await page.route("**/api/inventory/barcode/lookup/**", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          registered: false,
          item: null,
          pack: null,
          off: { product_name: "Whole Milk", brands: "Member's Mark", quantity: "1 gal" },
          suggestions: { name: "Whole Milk", category: "food", unit: "gal", unit_kind: "volume" }
        })
      })
    );

    let createBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/items", async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      createBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ item: item() }) });
    });
    await page.route("**/api/inventory/items/*/packs", (r) =>
      r.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ item: item({ packs: [PACK] }) }) })
    );
    let barcodeBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/items/*/barcodes", async (route, request) => {
      barcodeBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ item: item({ packs: [PACK] }) }) });
    });
    let recvBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/receive", async (route, request) => {
      recvBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ received: 1, created: 0 }) });
    });

    await loginMaya(page);
    await page.getByRole("button", { name: /Artículos/ }).click();
    // ＋New opens the "Add item" chooser; "Escanear código" is the scan-to-register entry point.
    await page.getByRole("button", { name: /Nuevo artículo/ }).click();
    await page.getByRole("button", { name: "Escanear código" }).click();

    // Scope to the overlay — the Artículos list stays mounted underneath, so its inputs would
    // otherwise collide with short labels like "En".
    const sheet = page.getByRole("dialog", { name: "Escanear para agregar" });

    // The seam fires onDetect → lookup → review form, pre-filled from OFF.
    await expect(sheet.getByText("encontrado — revisa")).toBeVisible();
    await expect(sheet.getByLabel("Nombre")).toHaveValue("Whole Milk");

    // Add the pack (1 Caja = 24), then register.
    await sheet.getByLabel("Paquete (opcional)").fill("Caja");
    await sheet.getByLabel("Unid. / paquete").fill("24");
    await sheet.getByRole("button", { name: "Registrar" }).click();

    // The receive step appears; the create + barcode-bind fired with the scanned code + pack.
    await expect(sheet.getByText("¿Cuánto recibiste?")).toBeVisible();
    expect(createBody).toMatchObject({ name: "Whole Milk", category: "food", unit: "gal" });
    expect(barcodeBody).toMatchObject({ code: UPC, source: "manufacturer", pack_id: "pack-1" });

    // Book 2 Caja → receive posts the line (qty in packs, pack_id set).
    const recvReq = page.waitForRequest(
      (r: Request) => r.url().includes("/api/inventory/receive") && r.method() === "POST"
    );
    await sheet.getByLabel("Recibir").fill("2");
    await sheet.getByLabel("En").selectOption("pack-1");
    await sheet.getByRole("button", { name: "Recibir", exact: true }).click();
    await recvReq;
    expect(recvBody).toMatchObject({ lines: [{ sku: "sku-new", qty: 2, pack_id: "pack-1" }] });
  });
});
