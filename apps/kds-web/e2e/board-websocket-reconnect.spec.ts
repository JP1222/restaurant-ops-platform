import { expect, test, type Page } from "@playwright/test";
import type {
  KdsTicket,
  KitchenBoardSettings,
  RealtimeEvent,
  TicketSnapshot
} from "@rop/contracts";

// Issue #161 — kds-web e2e: board recovers tickets after a WebSocket reconnect.
//
// When kds-api restarts mid-shift the board's socket closes. The board must NOT
// blank out: it keeps the tickets it already has, shows that the realtime link
// dropped, then reconnects and re-hydrates — and a freshly pushed ticket on the
// new connection must render. If a restart blanked the board, operators would
// start rebooting iPads "just in case" on every deploy.
//
// Mocks the kds-api BFF (HTTP + WebSocket) so the spec is deterministic and
// doesn't need Clover, Redis, BullMQ, or Postgres. Mirrors the harness in
// board-websocket.spec.ts; the WebSocket route additionally lets the test drop
// and re-accept the server side to simulate the restart.

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

function makeSnapshot(tickets: KdsTicket[], serverSeq: number): TicketSnapshot {
  return {
    merchantId: MERCHANT_ID,
    serverTime: BASE_TIME,
    serverSeq,
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

type BoardHarness = {
  /** Resolves once a client WebSocket has connected to the mock server. */
  waitForConnection(): Promise<void>;
  /** Number of times a client has opened the socket (initial + reconnects). */
  connectionCount(): number;
  /** Drop the current server side, simulating a kds-api restart. */
  dropConnection(): void;
  /** Push a ticket over the live socket (after a reconnect). */
  pushTicket(ticket: KdsTicket, seq: number): Promise<void>;
};

async function setupBoardBffMocks(
  page: Page,
  options: { snapshotTickets: () => KdsTicket[]; snapshotSeq: () => number }
): Promise<BoardHarness> {
  await page.route("**/api/kds/settings**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSettings())
    });
  });

  // The board re-hydrates after a reconnect by re-fetching the snapshot. Serve
  // whatever the test currently considers the server-of-record set.
  await page.route("**/api/kds/tickets?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(makeSnapshot(options.snapshotTickets(), options.snapshotSeq()))
    });
  });

  // The board may also reconcile via the backfill endpoint after a drop. Return
  // an empty, up-to-date window so it falls through to the live socket without
  // forcing an extra snapshot.
  await page.route("**/api/kds/events?**", async (route) => {
    const url = new URL(route.request().url());
    const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        merchantId: MERCHANT_ID,
        fromSeq: afterSeq,
        toSeq: afterSeq,
        events: [],
        snapshotRequired: false
      })
    });
  });

  await page.route("**/api/internal/realtime-receipts", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });

  let connectionCount = 0;
  let liveSend: ((message: string) => void) | null = null;
  let liveClose: (() => void) | null = null;
  let resolveConnection: (() => void) | null = null;
  let connectionWaiter: Promise<void> = new Promise((resolve) => {
    resolveConnection = resolve;
  });

  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    connectionCount += 1;
    liveSend = (message) => ws.send(message);
    liveClose = () => ws.close();

    ws.onMessage((message) => {
      if (typeof message === "string" && message === "ping") {
        ws.send("pong");
      }
    });

    resolveConnection?.();
    resolveConnection = null;
  });

  return {
    async waitForConnection() {
      await connectionWaiter;
      // Arm the waiter for the next reconnect.
      connectionWaiter = new Promise((resolve) => {
        resolveConnection = resolve;
      });
    },
    connectionCount() {
      return connectionCount;
    },
    dropConnection() {
      liveClose?.();
    },
    async pushTicket(ticket: KdsTicket, seq: number) {
      const event: RealtimeEvent = {
        id: `evt-${ticket.id}`,
        type: "ticket.created",
        merchantId: MERCHANT_ID,
        occurredAt: new Date().toISOString(),
        seq,
        ticket
      };
      liveSend?.(JSON.stringify(event));
    }
  };
}

test("board keeps its tickets through a WebSocket drop and re-hydrates on reconnect", async ({ page, context }) => {
  await context.addCookies([
    {
      name: "__e2e_kds_bypass",
      value: "1",
      url: "http://127.0.0.1:3000"
    }
  ]);

  // The mock server-of-record. Two tickets are live before the restart.
  let serverTickets: KdsTicket[] = [
    makeTicket({ id: "ticket-alpha", orderLabel: "Alpha" }),
    makeTicket({ id: "ticket-bravo", orderLabel: "Bravo" })
  ];
  let serverSeq = 1;

  const harness = await setupBoardBffMocks(page, {
    snapshotTickets: () => serverTickets,
    snapshotSeq: () => serverSeq
  });

  await page.goto(`/board?merchantId=${MERCHANT_ID}`);

  // Initial connection is established and both tickets are painted.
  await harness.waitForConnection();
  await expect(page.getByRole("heading", { name: "Alpha", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bravo", level: 3 })).toBeVisible();
  // The connection chip reports "online" once the socket opens.
  await expect(page.locator(".fresh-chip-online")).toHaveText("online");

  // Simulate kds-api restarting: drop the socket from the server side.
  harness.dropConnection();

  // The board must surface that the link dropped rather than silently stalling.
  await expect(page.getByText("Realtime link dropped.", { exact: false })).toBeVisible({ timeout: 4_000 });
  await expect(page.locator(".fresh-chip-offline")).toBeVisible();

  // Crucially, the board must NOT blank out — the tickets it already had stay on
  // screen through the outage.
  await expect(page.getByRole("heading", { name: "Alpha", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bravo", level: 3 })).toBeVisible();

  // The board auto-reconnects (~2s backoff). Wait for the new client connection.
  await harness.waitForConnection();
  expect(harness.connectionCount()).toBeGreaterThanOrEqual(2);

  // Back online, tickets still present, indicator cleared.
  await expect(page.locator(".fresh-chip-online")).toHaveText("online", { timeout: 6_000 });
  await expect(page.getByText("Realtime link dropped.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Alpha", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bravo", level: 3 })).toBeVisible();

  // A new ticket pushed on the fresh socket must render — proving the reconnected
  // realtime stream is actually wired through, not just visually "online".
  serverTickets = [...serverTickets, makeTicket({ id: "ticket-charlie", orderLabel: "Charlie" })];
  serverSeq = 2;
  await harness.pushTicket(serverTickets[serverTickets.length - 1], serverSeq);

  await expect(page.getByRole("heading", { name: "Charlie", level: 3 })).toBeVisible({ timeout: 4_000 });
});
