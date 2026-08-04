import { expect, test, type Page } from "@playwright/test";
import type {
  KdsTicket,
  KitchenBoardSettings,
  RealtimeEvent,
  TicketSnapshot
} from "@rop/contracts";

// Issue #125 — kds-web e2e: board renders ticket within 2s of websocket push.
// Mocks the kds-api BFF (HTTP + WebSocket) so the spec is deterministic and
// doesn't need Clover, Redis, BullMQ, or Postgres.

const MERCHANT_ID = "e2e-merchant";
const BASE_TIME = "2026-05-27T17:00:00.000Z";

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

async function setupBoardBffMocks(page: Page, initialTickets: KdsTicket[]): Promise<{
  pushTicket(ticket: KdsTicket, seq: number): Promise<void>;
}> {
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

  // /api/internal/realtime-receipts is fire-and-forget telemetry. Swallow it
  // so the page doesn't log a CORS / 404 error during the spec.
  await page.route("**/api/internal/realtime-receipts", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  let resolveServerReady: (() => void) | null = null;
  const serverReady = new Promise<void>((resolve) => {
    resolveServerReady = resolve;
  });
  const sendQueue: Array<() => void> = [];
  let routedSend: ((message: string) => void) | null = null;

  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    routedSend = (message) => ws.send(message);
    ws.onMessage((message) => {
      // The board sends "ping" heartbeats every 20s; reply so the connection
      // stays "online" through the run.
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
    async pushTicket(ticket: KdsTicket, seq: number) {
      const event: RealtimeEvent = {
        id: `evt-${ticket.id}`,
        type: "ticket.created",
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

test("board renders new ticket within 2s of a websocket push", async ({ page, context }) => {
  await context.addCookies([
    {
      name: "__e2e_kds_bypass",
      value: "1",
      url: "http://127.0.0.1:3000"
    }
  ]);

  const initialTickets = [
    makeTicket({ id: "ticket-alpha", orderLabel: "Alpha" }),
    makeTicket({ id: "ticket-bravo", orderLabel: "Bravo" })
  ];
  const realtime = await setupBoardBffMocks(page, initialTickets);

  await page.goto(`/board?merchantId=${MERCHANT_ID}`);

  // Hydrated snapshot — both fixture tickets are on screen before the push.
  await expect(page.getByRole("heading", { name: "Alpha", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bravo", level: 3 })).toBeVisible();

  // Charlie is not in the initial snapshot.
  await expect(page.getByRole("heading", { name: "Charlie", level: 3 })).toHaveCount(0);

  // Now push it over the WebSocket and require the card to paint within 2s.
  const pushedAt = Date.now();
  await realtime.pushTicket(
    makeTicket({ id: "ticket-charlie", orderLabel: "Charlie" }),
    2
  );

  await expect(page.getByRole("heading", { name: "Charlie", level: 3 })).toBeVisible({ timeout: 2_000 });
  const elapsedMs = Date.now() - pushedAt;
  expect(elapsedMs, `Charlie ticket should render in <2000ms, took ${elapsedMs}ms`).toBeLessThan(2_000);
});
