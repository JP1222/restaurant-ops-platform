import { expect, test, type Page, type Request } from "@playwright/test";

// crew-web e2e — Recibir flow (rebuilt to the design handoff's PO chips).
//
// receive-flow.tsx: PO chips switch open orders in place; each line is marked OK
// or Falta (Falta reveals a received-qty input); Confirmar recepción POSTs to the
// BFF route /api/inventory/pos/:id/receive (forwarded to inventory-api in prod).
// Wrong on-hand deltas cause 86 false-positives/negatives, so the per-line math is
// load-bearing. Mocked at the BFF boundary like pin-login.spec.ts.
//
// The chips read `pos` from the cached dataset (GET /api/inventory); the selected
// PO's richer per-line detail comes from GET /api/inventory/pos/:id.

const DIEGO = {
  id: "emp-diego",
  name: "Diego López",
  role: "Line Cook",
  shift: "AM",
  initials: "DL",
  color: "#2A6FDB"
};

const PO_SUMMARY = {
  id: "po-501",
  vendor: "US Foods",
  placed: "2026-05-26",
  expected: "2026-05-27",
  lines: 2,
  status: "in-transit",
  total_cents: 18000
};

const PO_DETAIL = {
  ...PO_SUMMARY,
  line_items: [
    { sku: "sku-001", name: "Chicken Thigh", unit: "case", qty_ordered: 4, qty_received: 0 },
    { sku: "sku-002", name: "Ribeye", unit: "case", qty_ordered: 6, qty_received: 0 }
  ]
};

const INVENTORY = {
  items: [],
  categories: [],
  pos: [PO_SUMMARY],
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
    if (pin === "258025") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ employee: DIEGO })
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
  // Per-PO detail for the selected chip. Match the id-scoped path explicitly so
  // the receive POST (a different verb on a sibling path) falls through to its own
  // handler registered per-test.
  await page.route("**/api/inventory/pos/po-501", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PO_DETAIL)
    })
  );
}

async function loginDiego(page: Page): Promise<void> {
  await page.goto("/");
  for (const digit of ["2", "5", "8", "0", "2", "5"]) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect(page.getByText("Movimientos")).toBeVisible();
}

test.describe("crew-web receive PO", () => {
  test("first line OK, second line Falta — confirm posts correct deltas", async ({ page }) => {
    await stubCrewBff(page);

    let receiveBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/pos/po-501/receive", async (route, request) => {
      receiveBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const receiveReq = page.waitForRequest(
      (r: Request) =>
        r.url().includes("/api/inventory/pos/po-501/receive") && r.method() === "POST"
    );

    await loginDiego(page);

    // Open Recibir; the only open PO is auto-selected and its lines load.
    await page.getByRole("button", { name: /Recibir/ }).click();
    await expect(page.getByRole("heading", { name: "Recibir" })).toBeVisible();
    await expect(page.getByText("Chicken Thigh")).toBeVisible();
    await expect(page.getByText("Ribeye")).toBeVisible();

    const chicken = page.getByTestId("rcv-line-sku-001");
    const ribeye = page.getByTestId("rcv-line-sku-002");

    // Line 1 — OK (received in full → qty stays qty_ordered = 4).
    await chicken.getByRole("button", { name: /OK/ }).click();

    // Line 2 — Falta, then dial the received qty down from 6 to 2.
    await ribeye.getByRole("button", { name: /Falta/ }).click();
    const shortInput = ribeye.getByRole("spinbutton");
    await expect(shortInput).toHaveValue("6"); // seeded with qty_ordered
    await shortInput.fill("2");

    await page.getByRole("button", { name: /Confirmar recepción/ }).click();

    await expect(page.getByRole("heading", { name: "¡Entrega registrada!" })).toBeVisible();
    await expect(page.getByText("Inventario actualizado")).toBeVisible();

    // Round-trip: OK line in full, Falta line the dialed-in qty, in PO order, plus
    // a client idempotency_key.
    await receiveReq;
    expect(receiveBody).toEqual({
      lines: [
        { sku: "sku-001", qty: 4 },
        { sku: "sku-002", qty: 2 }
      ],
      idempotency_key: expect.any(String)
    });
  });

  test('"Todo OK" marks every line then receives in full', async ({ page }) => {
    await stubCrewBff(page);

    let receiveBody: Record<string, unknown> | null = null;
    await page.route("**/api/inventory/pos/po-501/receive", async (route, request) => {
      receiveBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await loginDiego(page);

    await page.getByRole("button", { name: /Recibir/ }).click();
    await expect(page.getByText("Chicken Thigh")).toBeVisible();

    // The header shortcut marks all lines OK in one tap.
    await page.getByRole("button", { name: /Todo OK/ }).click();
    await page.getByRole("button", { name: /Confirmar recepción/ }).click();

    await expect(page.getByRole("heading", { name: "¡Entrega registrada!" })).toBeVisible();

    expect(receiveBody).toEqual({
      lines: [
        { sku: "sku-001", qty: 4 },
        { sku: "sku-002", qty: 6 }
      ],
      idempotency_key: expect.any(String)
    });
  });
});
