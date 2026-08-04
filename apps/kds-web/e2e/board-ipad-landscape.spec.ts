import { expect, test, type Page } from "@playwright/test";
import type {
  KdsTicket,
  KitchenBoardSettings,
  TicketSnapshot
} from "@rop/contracts";

// Issue #198 — kds-web e2e: board layout at iPad landscape 1024x768.
//
// Floor screens are mostly iPads mounted to the line in landscape. The root
// AGENTS.md review guideline flags iPad-landscape regressions explicitly: a
// layout that pushes the board off-screen forces the kitchen back to paper
// tickets. This spec pins the contract — at 1024x768 with a full board the page
// must not scroll horizontally, must show a multi-column grid, and must keep
// each ticket card wide enough to read across the line.
//
// Mocks the kds-api BFF (HTTP + WebSocket) so the spec is deterministic and
// doesn't need Clover, Redis, BullMQ, or Postgres. Mirrors the harness in
// board-websocket.spec.ts.

const MERCHANT_ID = "e2e-merchant";
const BASE_TIME = "2026-05-27T17:00:00.000Z";

// iPad (9th/10th gen) landscape CSS viewport. The kitchen mounts run here.
const IPAD_LANDSCAPE = { width: 1024, height: 768 };

function makeTicket(overrides: Partial<KdsTicket> & Pick<KdsTicket, "id" | "orderLabel">): KdsTicket {
  return {
    id: overrides.id,
    merchantId: MERCHANT_ID,
    provider: "clover",
    cloverOrderId: `clover-${overrides.id}`,
    sourceOrderId: `source-${overrides.id}`,
    orderLabel: overrides.orderLabel,
    status: "new",
    priority: 0,
    source: "Register",
    orderType: "Pickup",
    paymentState: "PAID",
    note: null,
    lastActor: null,
    heldAt: null,
    holdUntil: null,
    displayChannelLabel: null,
    displayFulfillmentTimeLabel: null,
    hasLocalEdits: false,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    elapsedMinutes: 0,
    items: [
      {
        id: `${overrides.id}-item-1`,
        cloverLineItemId: null,
        providerLineItemId: null,
        itemKey: `${overrides.id}-item-1`,
        itemId: null,
        name: `${overrides.orderLabel} sandwich`,
        alternateName: null,
        note: null,
        modifiers: [],
        quantity: 1,
        refunded: false,
        printed: false,
        completed: false,
        completedAt: null,
        completedBy: null
      }
    ],
    ...overrides
  };
}

function makeSnapshot(tickets: KdsTicket[]): TicketSnapshot {
  return {
    merchantId: MERCHANT_ID,
    serverTime: BASE_TIME,
    serverSeq: 1,
    tickets,
    filter: {
      allowedOrderTypes: [],
      blockedSources: [],
      paymentStates: [],
      createdAfterMinutes: null,
      searchText: "",
      includeCompleted: false,
      soundEnabled: false,
      screenPinEnabled: false
    }
  };
}

function makeSettings(): KitchenBoardSettings {
  return {
    boardTimeZone: "UTC",
    dailyResetEnabled: false,
    dailyResetTime: "21:00",
    reconcileIntervalSeconds: 45,
    urgencyWarningMinutes: 8,
    urgencyCriticalMinutes: 15,
    urgencyBlinkCritical: true,
    modifierDangerKeywords: [],
    modifierAccentKeywords: [],
    display: {
      weather: {
        enabled: false,
        zipCode: "",
        countryCode: "US",
        unit: "fahrenheit"
      }
    },
    providers: {
      deliverect: {
        enabled: false,
        environment: "staging",
        externalLocationId: "",
        locationId: "",
        channelLinkId: "",
        apiToken: "",
        hmacSecret: "",
        registerWebhookStatus: null,
        ordersWebhookStatus: null,
        lastRegisterWebhookAt: null,
        lastOrderWebhookAt: null
      }
    },
    filter: {
      allowedOrderTypes: [],
      blockedSources: [],
      paymentStates: [],
      createdAfterMinutes: null,
      searchText: "",
      includeCompleted: false,
      soundEnabled: false,
      screenPinEnabled: false
    }
  };
}

async function setupBoardBffMocks(page: Page, initialTickets: KdsTicket[]): Promise<void> {
  await page.route("**/api/kds/settings**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSettings())
    });
  });

  await page.route("**/api/kds/tickets?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSnapshot(initialTickets))
    });
  });

  // /api/internal/realtime-receipts is fire-and-forget telemetry.
  await page.route("**/api/internal/realtime-receipts", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  // Keep the socket open and heartbeat-friendly so the connection stays "online"
  // and never paints the offline toast (which would change layout height).
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    ws.onMessage((message) => {
      if (typeof message === "string" && message === "ping") {
        ws.send("pong");
      }
    });
  });
}

// A full lunch rush — eight tickets in the active grid.
function eightTicketBoard(): KdsTicket[] {
  return [
    makeTicket({ id: "ticket-1", orderLabel: "Order 1" }),
    makeTicket({ id: "ticket-2", orderLabel: "Order 2" }),
    makeTicket({ id: "ticket-3", orderLabel: "Order 3" }),
    makeTicket({ id: "ticket-4", orderLabel: "Order 4" }),
    makeTicket({ id: "ticket-5", orderLabel: "Order 5" }),
    makeTicket({ id: "ticket-6", orderLabel: "Order 6" }),
    makeTicket({ id: "ticket-7", orderLabel: "Order 7" }),
    makeTicket({ id: "ticket-8", orderLabel: "Order 8" })
  ];
}

test.use({ viewport: IPAD_LANDSCAPE });

test("board fits an 8-ticket rush on an iPad in landscape (1024x768)", async ({ page, context }) => {
  await context.addCookies([
    {
      name: "__e2e_kds_bypass",
      value: "1",
      url: "http://127.0.0.1:3000"
    }
  ]);

  await setupBoardBffMocks(page, eightTicketBoard());

  await page.goto(`/board?merchantId=${MERCHANT_ID}`);

  // Wait for the hydrated snapshot — all eight cards are on screen.
  await expect(page.getByRole("heading", { name: "Order 1", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Order 8", level: 3 })).toBeVisible();

  const cards = page.locator(".fresh-ticket-grid .fresh-ticket");
  await expect(cards).toHaveCount(8);

  // 1. No horizontal overflow: the document must never scroll sideways. A board
  //    that bleeds off the right edge of the iPad is the regression operators
  //    feel first.
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth
    };
  });
  expect(
    overflow.scrollWidth,
    `document scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`
  ).toBeLessThanOrEqual(overflow.clientWidth);

  // Also assert against the configured viewport width so a future change can't
  // silently grow the page past the iPad's 1024px.
  expect(overflow.clientWidth).toBeLessThanOrEqual(IPAD_LANDSCAPE.width);

  // 2. The grid must lay tickets out in exactly three columns. globals.css pins
  //    iPad landscape (1024–1399px) to `repeat(3, ...)` on purpose — the comment
  //    there notes it locks 3 columns "so borderline widths don't oscillate
  //    2<->3" (4 columns only unlock at >=1700px). So the contract this screen
  //    must hold is three columns, not the off-the-cuff "at least 4" from the
  //    issue; a drop to 2 (board feels cramped) or a jump to 4 (cards too narrow
  //    to read across the line) is the regression. Tickets in the same row share
  //    a y; distinct x positions in the topmost row give the column count without
  //    coupling to the exact grid template.
  const boxes = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width) };
    })
  );

  const topY = Math.min(...boxes.map((box) => box.y));
  const topRowXs = new Set(
    boxes.filter((box) => Math.abs(box.y - topY) <= 4).map((box) => box.x)
  );
  expect(
    topRowXs.size,
    `expected exactly 3 columns in the top row, saw ${topRowXs.size} (xs: ${[...topRowXs].sort((a, b) => a - b).join(", ")})`
  ).toBe(3);

  // 3. Cards must stay readable across the line — no squished sliver columns.
  const minWidth = Math.min(...boxes.map((box) => box.width));
  expect(
    minWidth,
    `narrowest ticket card was ${minWidth}px, expected each card to be >= 200px`
  ).toBeGreaterThanOrEqual(200);

  // 4. Every card must sit fully inside the viewport (no right-edge clipping).
  const rightEdges = boxes.map((box) => box.x + box.width);
  const maxRight = Math.max(...rightEdges);
  expect(
    maxRight,
    `right-most card edge was ${maxRight}px, must stay within the ${IPAD_LANDSCAPE.width}px viewport`
  ).toBeLessThanOrEqual(IPAD_LANDSCAPE.width);
});
