import { expect, test, type Page, type Request } from "@playwright/test";

// crew-web e2e — Escanear factura (AI invoice scan, ADR-0538 / design handoff §3).
//
// scan-flow.tsx: capture → analyzing → human-review → import. Extraction posts to
// the BFF route /api/inventory/scan (proxies to backoffice's Gemini vision parse; a
// deterministic live-catalog stub is the dev-only fallback when unconfigured);
// description→item matching is deterministic client-side (lib/scan.ts). Confirm
// calls the REAL ad-hoc receive (POST /api/inventory/receive) + a per-line reprice
// PUT for matched lines whose invoice price changed. We mock all of these at the
// BFF boundary and assert the receive payload — the contract that actually moves
// stock. (At Playwright's 1280x720 viewport useCrewSize() reports desktop.)

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

// One catalog item the first scanned line will match (cost 80c; the invoice lists
// 88c → a +10% price change). sku-001 has a glyph in ITEM_GLYPHS.
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
  categories: [
    { id: "food", name: "Proteína", color: "#ef4444" },
    { id: "dairy", name: "Lácteos", color: "#3b82f6" }
  ],
  pos: [],
  waste_reasons: [],
  waste_settings: { photo_required_over_cents: 5000, manager_approval_over_cents: 10000 }
};

// What the (stubbed) extractor returns: one line that matches Chicken Thigh at a
// higher price, one unrecognized line that becomes a new-SKU inline create.
const PARSE = {
  vendor: "Sam's Club",
  lines: [
    { description: "CHICKEN THIGH CASE", qty: 4, unit: "case", unit_price_cents: 88 },
    { description: "OAT MILK 1/2 GAL", qty: 6, unit: "ctn", unit_price_cents: 510 }
  ]
};

// A 1x1 PNG — enough for resizeImageForUpload's createImageBitmap/canvas path.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

// A minimal one-page PDF (blank MediaBox). pdf.js rebuilds the missing xref and
// renders the blank page, so this exercises the real lib/pdf.ts → pdfjs worker
// path in the browser. If the worker were misbundled, render would throw and the
// flow would never leave the capture screen.
const MINIMAL_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>",
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF"
  ].join("\n"),
  "utf-8"
);

async function stubCrewBff(page: Page): Promise<void> {
  await page.route("**/api/crew/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) })
  );
  await page.route("**/api/crew/login", async (route, request) => {
    let pin: unknown;
    try {
      pin = (request.postDataJSON() as { pin?: unknown })?.pin;
    } catch {
      pin = undefined;
    }
    if (pin === "123456") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ employee: MAYA }) });
      return;
    }
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid" }) });
  });
  await page.route("**/api/inventory", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVENTORY) })
  );
  // Stubbed extraction.
  await page.route("**/api/inventory/scan", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PARSE) })
  );
  // Matched-line reprice PUT (saveItemCost) — return the item so the call resolves.
  await page.route("**/api/inventory/items/sku-001", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ item: CHICKEN }) })
  );
}

async function loginMaya(page: Page): Promise<void> {
  await page.goto("/");
  for (const digit of ["1", "2", "3", "4", "5", "6"]) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect(page.getByText("Movimientos")).toBeVisible();
}

test.describe("crew-web invoice scan", () => {
  test("capture → review → import posts the ad-hoc receive for matched + new lines", async ({
    page
  }) => {
    await stubCrewBff(page);

    let receiveBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/receive", async (route, request) => {
      receiveBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ received: 1, created: 1 }) });
    });
    const receiveReq = page.waitForRequest(
      (r: Request) => r.url().includes("/api/inventory/receive") && r.method() === "POST"
    );

    await loginMaya(page);

    // Open the scan hero, then feed the upload input (the camera input carries
    // `capture` and is a separate element now).
    await page.getByRole("button", { name: /Escanear factura/ }).click();
    await page.getByTestId("scan-file-input").setInputFiles({
      name: "invoice.png",
      mimeType: "image/png",
      buffer: PNG_1X1
    });

    // After the analyzing animation the review table renders under the vendor
    // header. The price-change chip proves the first line matched Chicken Thigh
    // (matched + invoice price ≠ stored cost); the "Nuevo" badge proves the second
    // line is an unrecognized inline-create.
    await expect(page.getByRole("heading", { name: "Sam's Club" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Cambio de precio")).toBeVisible();
    await expect(page.getByText("Nuevo", { exact: true })).toBeVisible();

    // Import both lines.
    await page.getByRole("button", { name: /Importar al inventario \(2\)/ }).click();
    await expect(page.getByRole("heading", { name: "¡Inventario actualizado!" })).toBeVisible();

    // The receive payload: matched line by sku at the invoice price (Actualizar
    // precio on by default), unrecognized line inline-creates (prettified name +
    // unit + a deterministic category guess: "OAT MILK …" → dairy via
    // categoryFromText, ADR-882, never the old categories[0] default), plus a
    // client idempotency_key. Every line also
    // carries the raw printed description so the receive can learn the vendor's
    // wording as an alias (ADR-0586). Since the receipt-archive work (ADR-0670 /
    // #670) the confirmed scan also archives its capture alongside the receive:
    // the resize pipeline always emits JPEG, and the bytes ride as bare base64
    // (browser-dependent, so matched loosely). `invoice_date` stays absent — this
    // stub parse carries no date and receiveAdHoc omits an undefined one (it never
    // survives JSON.stringify). A full toEqual still guards against any other drift.
    await receiveReq;
    expect(receiveBody).toEqual({
      vendor: "Sam's Club",
      lines: [
        { sku: "sku-001", qty: 4, unit_cost_cents: 88, description: "CHICKEN THIGH CASE" },
        {
          name: "Oat Milk 1/2 Gal",
          category: "dairy",
          unit: "ctn",
          qty: 6,
          unit_cost_cents: 510,
          description: "OAT MILK 1/2 GAL"
        }
      ],
      idempotency_key: expect.any(String),
      receipt_content_type: "image/jpeg",
      receipt_image_base64: expect.any(String)
    });
  });

  test("groups same-product different-size lines into one item with packs (ADR-882)", async ({
    page
  }) => {
    await stubCrewBff(page);
    // Override the extractor: two SIZES of one NEW product (not in the catalog).
    await page.route("**/api/inventory/scan", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          vendor: "Sam's Club",
          lines: [
            { description: "GUMMY BEARS 28 OZ", canonical_name: "Gummy Bears 28 oz", qty: 2, unit: "bag", unit_price_cents: 663 },
            { description: "GUMMY BEARS 5 LB", canonical_name: "Gummy Bears 5 lb", qty: 1, unit: "bag", unit_price_cents: 1086 }
          ]
        })
      })
    );

    let receiveBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/receive", async (route, request) => {
      receiveBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ received: 2, created: 1 }) });
    });
    const receiveReq = page.waitForRequest(
      (r: Request) => r.url().includes("/api/inventory/receive") && r.method() === "POST"
    );

    await loginMaya(page);
    await page.getByRole("button", { name: /Escanear factura/ }).click();
    await page.getByTestId("scan-file-input").setInputFiles({ name: "invoice.png", mimeType: "image/png", buffer: PNG_1X1 });

    await expect(page.getByRole("heading", { name: "Sam's Club" })).toBeVisible({ timeout: 10_000 });
    // The grouping badge ("Mismo artículo") proves the two sizes collapsed into one item.
    await expect(page.getByText("Mismo artículo").first()).toBeVisible();

    await page.getByRole("button", { name: /Importar al inventario \(2\)/ }).click();
    await expect(page.getByRole("heading", { name: "¡Inventario actualizado!" })).toBeVisible();

    await receiveReq;
    expect(receiveBody).not.toBeNull();
    const lines = (receiveBody as unknown as { lines: Array<Record<string, unknown>> }).lines;
    expect(lines).toHaveLength(2);
    // One family group + one base unit (oz), with each printed size converted into it (5 lb -> 80 oz).
    expect(lines[0]!.item_group).toBe("fam:gummybear");
    expect(lines[1]!.item_group).toBe(lines[0]!.item_group);
    expect(lines[0]).toMatchObject({
      name: "Gummy Bears",
      category: "topping",
      unit: "oz",
      qty: 2,
      unit_cost_cents: 663,
      new_pack: { label: "28 oz", base_qty_per_pack: 28 }
    });
    expect(lines[1]).toMatchObject({
      name: "Gummy Bears",
      category: "topping",
      unit: "oz",
      qty: 1,
      unit_cost_cents: 1086,
      new_pack: { label: "5 lb", base_qty_per_pack: 80 }
    });
  });

  test("review with unsaved edits asks before discarding; a clean review leaves silently", async ({
    page
  }) => {
    await stubCrewBff(page);
    await loginMaya(page);

    const reachReview = async () => {
      await page.getByRole("button", { name: /Escanear factura/ }).click();
      await page.getByTestId("scan-file-input").setInputFiles({
        name: "invoice.png",
        mimeType: "image/png",
        buffer: PNG_1X1
      });
      await expect(page.getByRole("heading", { name: "Sam's Club" })).toBeVisible({ timeout: 10_000 });
    };

    // No edits: the top-bar back leaves without nagging.
    await reachReview();
    await page.getByRole("button", { name: "Atrás" }).click();
    await expect(page.getByText("Movimientos")).toBeVisible();
    await expect(page.getByText("¿Salir sin guardar?")).toHaveCount(0);

    // Edited (qty stepper): the chevron is intercepted — stay keeps the review,
    // discard leaves the flow.
    await reachReview();
    await page.getByRole("button", { name: "+", exact: true }).first().click();
    await page.getByRole("button", { name: "Atrás" }).click();
    await expect(page.getByText("¿Salir sin guardar?")).toBeVisible();
    await page.getByRole("button", { name: "Seguir editando" }).click();
    await expect(page.getByText("¿Salir sin guardar?")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Sam's Club" })).toBeVisible();
    await page.getByRole("button", { name: "Atrás" }).click();
    await page.getByRole("button", { name: "Descartar cambios" }).click();
    await expect(page.getByText("Movimientos")).toBeVisible();

    // Edited + the in-flow Cancelar: same confirm, but discard returns to capture.
    await reachReview();
    await page.getByRole("button", { name: "+", exact: true }).first().click();
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByText("¿Salir sin guardar?")).toBeVisible();
    await page.getByRole("button", { name: "Descartar cambios" }).click();
    await expect(page.getByRole("button", { name: "Tomar foto" })).toBeVisible();
  });

  test("a PDF invoice renders client-side (pdf.js) and reaches the review screen", async ({
    page
  }) => {
    await stubCrewBff(page);
    await loginMaya(page);

    // Upload a PDF — lib/pdf.ts renders its first page to a JPEG in the browser
    // (real pdfjs worker), then the same scan pipeline runs. Reaching the review
    // screen proves the PDF→image path worked end-to-end.
    await page.getByRole("button", { name: /Escanear factura/ }).click();
    await page.getByTestId("scan-file-input").setInputFiles({
      name: "invoice.pdf",
      mimeType: "application/pdf",
      buffer: MINIMAL_PDF
    });

    await expect(page.getByRole("heading", { name: "Sam's Club" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Importar al inventario/ })).toBeVisible();
  });

  test("a 503 from the scanner reads 'service unavailable / tell your manager', not an offline error", async ({
    page
  }) => {
    await stubCrewBff(page);
    // Override the extraction to fail closed (503 scan_not_configured) — the prod
    // path when the AI token/key is missing. This used to map to "Sin conexión.
    // Revisa el internet" (No connection. Check the internet), wrongly blaming the
    // cook's WiFi for a server-side outage. It must now escalate to a manager.
    await page.route("**/api/inventory/scan", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "scan_not_configured" })
      })
    );
    await loginMaya(page);

    await page.getByRole("button", { name: /Escanear factura/ }).click();
    await page.getByTestId("scan-file-input").setInputFiles({
      name: "invoice.png",
      mimeType: "image/png",
      buffer: PNG_1X1
    });

    // 503 → "unavailable" → the manager-escalation copy (ES is the default), and
    // crucially NOT the misleading offline message.
    await expect(page.getByText("Servicio no disponible. Avisa a tu gerente.")).toBeVisible({
      timeout: 10_000
    });
    await expect(page.getByText(/Revisa el internet/)).toHaveCount(0);
  });
});
