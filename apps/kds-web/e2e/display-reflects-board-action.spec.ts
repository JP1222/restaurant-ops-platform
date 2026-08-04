import { expect, test, type Page } from "@playwright/test";
import type { KdsTicket } from "@rop/contracts";

// Issue #223 — kds-web e2e: /display reflects a customer order's status after a
// board action.
//
// board.spec.ts only checks that /display renders the "Pickup Orders" header. No
// spec asserts that completing a ticket on the line actually moves that order
// into the customer-facing "Ready for Pickup" column.
//
// Modeling note: /board and /display are independent clients of kds-api (Iron
// Law #4 — Floor vs Backoffice/Customer surfaces). The board does not talk to
// the display directly; a board "bump" is observable to the display only as the
// realtime event kds-api fans out — the same orderId arriving with every item
// completed (isPickupReady === true; see src/lib/customer-display.ts). Playwright
// route handlers are per-context, so there is no shared in-process backend to
// wire two real pages together deterministically. This spec therefore drives the
// display through exactly that downstream contract: it stubs the customer
// snapshot/WebSocket BFF and pushes the post-bump ticket the API would emit, then
// asserts the order migrates Preparing -> Ready for Pickup. Mirrors the harness in
// board-websocket.spec.ts.

const MERCHANT_ID = "e2e-merchant";
const BASE_TIME = "2026-05-27T17:00:00.000Z";

// The display snapshot/event shape is the customer-visible subset of KdsTicket.
type DisplayTicket = Pick<KdsTicket, "id" | "merchantId" | "orderLabel" | "sourceOrderId" | "status" | "createdAt" | "updatedAt"> & {
  items: Array<Pick<KdsTicket["items"][number], "itemKey" | "name" | "alternateName" | "refunded" | "quantity" | "completed">>;
};

function makeDisplayTicket(
  overrides: Partial<DisplayTicket> & Pick<DisplayTicket, "id" | "orderLabel">,
  itemCompleted: boolean
): DisplayTicket {
  return {
    id: overrides.id,
    merchantId: MERCHANT_ID,
    orderLabel: overrides.orderLabel,
    sourceOrderId: `source-${overrides.id}`,
    status: itemCompleted ? "ready" : "in_progress",
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    items: [
      {
        itemKey: `${overrides.id}-item-1`,
        name: `${overrides.orderLabel} sandwich`,
        alternateName: null,
        refunded: false,
        quantity: 1,
        completed: itemCompleted
      }
    ],
    ...overrides
  };
}

function makeDisplaySnapshot(tickets: DisplayTicket[], serverSeq: number) {
  return {
    merchantId: MERCHANT_ID,
    serverTime: BASE_TIME,
    serverSeq,
    display: {
      weather: {
        enabled: false,
        zipCode: "",
        countryCode: "US",
        unit: "fahrenheit"
      }
    },
    tickets
  };
}

async function setupDisplayBffMocks(
  page: Page,
  initialTickets: DisplayTicket[]
): Promise<{ pushTicket(ticket: DisplayTicket, seq: number): Promise<void> }> {
  await page.route("**/api/display/tickets?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeDisplaySnapshot(initialTickets, 1))
    });
  });

  let resolveServerReady: (() => void) | null = null;
  const serverReady = new Promise<void>((resolve) => {
    resolveServerReady = resolve;
  });
  const sendQueue: Array<() => void> = [];
  let routedSend: ((message: string) => void) | null = null;

  // The customer display connects to /ws/display (distinct from the board's /ws).
  await page.routeWebSocket(/\/ws\/display(\?|$)/, (ws) => {
    routedSend = (message) => ws.send(message);
    ws.onMessage((message) => {
      if (typeof message === "string" && message === "ping") {
        ws.send("pong");
      }
    });
    resolveServerReady?.();
    for (const fn of sendQueue.splice(0)) {
      fn();
    }
  });

  return {
    async pushTicket(ticket: DisplayTicket, seq: number) {
      const event = {
        id: `evt-${ticket.id}`,
        type: "ticket.updated",
        merchantId: MERCHANT_ID,
        occurredAt: new Date().toISOString(),
        seq,
        ticket
      };
      const payload = JSON.stringify(event);
      await serverReady;
      if (routedSend) {
        routedSend(payload);
      } else {
        sendQueue.push(() => routedSend?.(payload));
      }
    }
  };
}

test("/display moves an order to Ready for Pickup when the board completes it", async ({ page }) => {
  // /display is a public surface — no auth bypass cookie required.
  const orderInProgress = makeDisplayTicket({ id: "ticket-jordan", orderLabel: "Jordan" }, false);
  const realtime = await setupDisplayBffMocks(page, [orderInProgress]);

  await page.goto(`/display?merchantId=${MERCHANT_ID}`);

  const preparingColumn = page.getByRole("region", { name: "Orders in progress" });
  const readyColumn = page.getByRole("region", { name: "Orders ready for pickup" });

  // Before the bump: Jordan is cooking — it sits in the Preparing column and is
  // absent from the Ready column.
  await expect(preparingColumn.getByLabel("Order Jordan preparing")).toBeVisible();
  await expect(readyColumn.getByLabel("Order Jordan ready for pickup")).toHaveCount(0);

  // The line bumps the order on /board. kds-api fans out the resulting realtime
  // event to the display: same orderId, every item now completed.
  const pushedAt = Date.now();
  const orderReady = makeDisplayTicket({ id: "ticket-jordan", orderLabel: "Jordan" }, true);
  await realtime.pushTicket(orderReady, 2);

  // The display must reflect it: Jordan migrates into Ready for Pickup within 2s.
  await expect(readyColumn.getByLabel("Order Jordan ready for pickup")).toBeVisible({ timeout: 2_000 });
  const elapsedMs = Date.now() - pushedAt;
  expect(elapsedMs, `Jordan should reach Ready in <2000ms, took ${elapsedMs}ms`).toBeLessThan(2_000);

  // ...and it must leave the Preparing column so a customer sees one clear state.
  await expect(preparingColumn.getByLabel("Order Jordan preparing")).toHaveCount(0);

  // The Ready tile renders the customer-facing label.
  await expect(readyColumn.getByText("Jordan", { exact: true })).toBeVisible();
});
