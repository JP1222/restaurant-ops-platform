import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { registerKdsRoutes } from "../src/routes/kds.js";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    apiPort: 4000,
    appBaseUrl: "https://kds.example.com",
    sessionSecret: "test-secret",
    databaseUrl: "postgres://example",
    redisUrl: "redis://example",
    webLoginUsername: "admin",
    webLoginPasswordHash: "hash",
    webLoginDisplayName: "Kitchen Admin",
    webauthnRpId: "kds.example.com",
    webauthnRpName: "Example Kitchen KDS",
    webSessionTtlHours: 12,
    cloverBaseUrl: "https://api.clover.com",
    cloverRegion: "US",
    cloverMerchantId: undefined,
    cloverToken: undefined,
    cloverAppId: undefined,
    cloverAppSecret: undefined,
    cloverWebhookAuthCode: "webhook-secret",
    deliverectWebhookSecret: undefined,
    deliverectWebhookSignatureHeader: "x-server-authorization-hmac-sha256",
    deliverectApiUrl: "https://api.deliverect.com",
    deliverectStagingApiUrl: "https://staging.deliverect.com",
    reconcileIntervalMs: 45_000,
    workerIntervalMs: 1_000,
    dailyResetEnabled: false,
    dailyResetHour: 21,
    dailyResetMinute: 0,
    dailyResetTimezone: "UTC",
    dailyResetCheckIntervalMs: 30_000,
    ...overrides
  };
}

function createServices() {
  const deleteOrder = vi.fn(async () => undefined);
  const ticketRows = [
    {
      id: "ticket-ready",
      merchantId: "merchant-1",
      orderLabel: "#57",
      sourceOrderId: "order-ready",
      status: "READY",
      createdAt: new Date("2026-04-23T23:29:00.000Z"),
      updatedAt: new Date("2026-04-24T01:44:00.000Z"),
      items: [
        {
          itemKey: "item-1",
          name: "Mango Bubble Tea",
          alternateName: null,
          quantity: 1,
          refunded: false,
          completed: false
        }
      ]
    },
    {
      id: "ticket-new",
      merchantId: "merchant-1",
      orderLabel: "#58",
      sourceOrderId: "order-new",
      status: "NEW",
      createdAt: new Date("2026-04-23T23:32:00.000Z"),
      updatedAt: new Date("2026-04-23T23:32:00.000Z"),
      items: [
        {
          itemKey: "item-2",
          name: "Strawberry Smoothie",
          alternateName: null,
          quantity: 1,
          refunded: false,
          completed: false
        }
      ]
    }
  ];
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    if (where.id === "missing-ticket") {
      return null;
    }

    return {
      id: where.id,
      merchantId: "merchant-1",
      cloverOrderId: "order-1"
    };
  });

  return {
    config: makeConfig(),
    hub: {
      currentSeq: vi.fn(async () => 0),
      publishSnapshotRequired: vi.fn(async () => undefined)
    },
    prisma: {
      kdsTicket: {
        findUnique,
        findMany: vi.fn(async () => ticketRows)
      },
      kdsFilter: {
        findUnique: vi.fn(async () => ({
          merchantId: "merchant-1",
          boardSettings: {
            display: {
              weather: {
                enabled: true,
                zipCode: "00000",
                countryCode: "US",
                unit: "fahrenheit"
              }
            }
          }
        }))
      },
      $transaction: vi.fn(async (callback: (tx: { cloverOrder: { delete: typeof deleteOrder } }) => Promise<void>) =>
        callback({
          cloverOrder: {
            delete: deleteOrder
          }
        })
      )
    }
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kds routes", () => {
  it("deletes a ticket locally without requiring any Clover write-back", async () => {
    const services = createServices();
    const app = Fastify();
    await registerKdsRoutes(app as never, services);

    try {
      // ?merchantId scopes the caller to merchant-1 (in production the app-level
      // preHandler sets request.kdsMerchantId; here we register the route module
      // standalone, so the route falls back to the query param). The ticket also
      // belongs to merchant-1, so the ownership guard lets the delete proceed.
      const response = await app.inject({
        method: "DELETE",
        url: "/api/kds/tickets/ticket-1?merchantId=merchant-1"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        merchantId: "merchant-1",
        orderId: "order-1",
        ticketId: "ticket-1"
      });
      expect(services.prisma.kdsTicket.findUnique).toHaveBeenCalledWith({
        where: { id: "ticket-1" },
        select: {
          id: true,
          merchantId: true,
          cloverOrderId: true
        }
      });
      expect(services.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(services.hub.publishSnapshotRequired).toHaveBeenCalledWith("merchant-1", "ticket-deleted");
    } finally {
      await app.close();
    }
  });

  it("returns 404 when the ticket does not exist", async () => {
    const services = createServices();
    const app = Fastify();
    await registerKdsRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/kds/tickets/missing-ticket?merchantId=merchant-1"
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Ticket not found."
      });
    } finally {
      await app.close();
    }
  });

  it("DELETE rejects a cross-merchant id with 403 and never touches the order rows (#472)", async () => {
    const services = createServices();
    const app = Fastify();
    await registerKdsRoutes(app as never, services);

    try {
      // The ticket belongs to merchant-1; a caller scoped to merchant-2 must be
      // forbidden BEFORE the destructive kdsTicket + cloverOrder cascade runs.
      const response = await app.inject({
        method: "DELETE",
        url: "/api/kds/tickets/ticket-1?merchantId=merchant-2"
      });

      expect(response.statusCode).toBe(403);
      expect(services.prisma.$transaction).not.toHaveBeenCalled();
      expect(services.hub.publishSnapshotRequired).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("serializes customer display statuses with contract casing", async () => {
    const services = createServices();
    const app = Fastify();
    await registerKdsRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/display/tickets?merchantId=merchant-1"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        merchantId: "merchant-1",
        display: {
          weather: {
            enabled: true,
            zipCode: "00000",
            countryCode: "US",
            unit: "fahrenheit"
          }
        },
        tickets: [
          {
            id: "ticket-ready",
            orderLabel: "#57",
            status: "ready"
          },
          {
            id: "ticket-new",
            orderLabel: "#58",
            status: "new"
          }
        ]
      });
      expect(services.prisma.kdsTicket.findMany).toHaveBeenCalledWith({
        where: {
          merchantId: "merchant-1",
          OR: [
            { status: { not: "COMPLETED" } },
            { status: "COMPLETED", completedAt: { gte: expect.any(Date) } }
          ]
        },
        include: {
          items: {
            select: {
              itemKey: true,
              name: true,
              alternateName: true,
              quantity: true,
              refunded: true,
              completed: true
            }
          }
        },
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }]
      });
    } finally {
      await app.close();
    }
  });

  it("reuses rapid customer display snapshots for the same merchant", async () => {
    const services = createServices();
    const app = Fastify();
    await registerKdsRoutes(app as never, services);

    try {
      const first = await app.inject({
        method: "GET",
        url: "/api/display/tickets?merchantId=merchant-1"
      });
      const second = await app.inject({
        method: "GET",
        url: "/api/display/tickets?merchantId=merchant-1"
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(services.prisma.kdsTicket.findMany).toHaveBeenCalledTimes(1);
      expect(services.prisma.kdsFilter.findUnique).toHaveBeenCalledTimes(1);
      expect(services.hub.currentSeq).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
