import Fastify from "fastify";
import { OrderProvider, Prisma } from "@rop/db-kds";
import { describe, expect, it, vi } from "vitest";
import { registerInternalRoutes } from "../src/routes/internal.js";

function createServices() {
  return {
    config: {
      appBaseUrl: "https://kds.example.com",
      kdsInternalAdminToken: "internal-admin-token-0123456789",
      cloverMerchantId: "merchant-1"
    },
    prisma: {
      kdsRealtimeEvent: {
        findUnique: vi.fn(async () => ({
          payload: {
            trace: {
              providerEventId: "event-1",
              webhookReceivedAt: "2026-04-24T12:00:00.000Z",
              realtimePublishedAt: "2026-04-24T12:00:01.000Z"
            }
          }
        }))
      },
      kdsRealtimeReceipt: {
        create: vi.fn(async () => ({}))
      }
    },
    queue: {
      enqueue: vi.fn(async () => undefined)
    }
  } as never;
}

describe("internal routes", () => {
  it("rejects realtime receipts from untrusted origins", async () => {
    const app = Fastify();
    await registerInternalRoutes(app as never, createServices());

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/realtime-receipts",
        headers: {
          origin: "https://evil.example.com"
        },
        payload: {
          eventId: "realtime-1",
          merchantId: "merchant-1",
          ticketId: "ticket-1",
          browserReceivedAt: "2026-04-24T12:00:01.250Z",
          renderCommittedAt: "2026-04-24T12:00:01.300Z"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "Untrusted origin.",
        expectedOrigin: "https://kds.example.com"
      });
    } finally {
      await app.close();
    }
  });

  it("stores realtime receipt latency samples from trusted origins", async () => {
    const app = Fastify();
    const services = createServices();
    await registerInternalRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/realtime-receipts",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {
          eventId: "realtime-1",
          merchantId: "merchant-1",
          ticketId: "ticket-1",
          browserReceivedAt: "2026-04-24T12:00:01.250Z",
          renderCommittedAt: "2026-04-24T12:00:01.300Z"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(services.prisma.kdsRealtimeReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: "realtime-1",
          merchantId: "merchant-1",
          ticketId: "ticket-1",
          providerEventId: "event-1",
          webhookToRenderMs: 1300,
          realtimeToBrowserMs: 250,
          browserRenderMs: 50
        })
      });
    } finally {
      await app.close();
    }
  });

  it("forwards the request correlation id into the manual-sync job", async () => {
    // Fastify configured like prod buildApp so an incoming x-request-id becomes
    // request.id; the manual-sync route must thread it into the enqueued job so
    // a failed sync ties back to this caller in the worker's failure log.
    const app = Fastify({ requestIdHeader: "x-request-id" });
    const services = createServices();
    await registerInternalRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/sync/orders/order-1?merchantId=merchant-1",
        headers: {
          "x-request-id": "corr-xyz",
          authorization: "Bearer internal-admin-token-0123456789"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(services.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceOrderId: "order-1",
          merchantId: "merchant-1",
          reason: "manual",
          requestId: "corr-xyz"
        })
      );
    } finally {
      await app.close();
    }
  });

  it("deduplicates repeated realtime receipts by event id", async () => {
    const app = Fastify();
    const services = createServices();
    const duplicate = new Prisma.PrismaClientKnownRequestError("Duplicate receipt", {
      code: "P2002",
      clientVersion: "test"
    });
    vi.mocked(services.prisma.kdsRealtimeReceipt.create).mockRejectedValueOnce(duplicate);
    await registerInternalRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/realtime-receipts",
        headers: {
          origin: "https://kds.example.com"
        },
        payload: {
          eventId: "realtime-1",
          merchantId: "merchant-1",
          ticketId: "ticket-1",
          browserReceivedAt: "2026-04-24T12:00:01.250Z",
          renderCommittedAt: "2026-04-24T12:00:01.300Z"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, duplicate: true });
    } finally {
      await app.close();
    }
  });
});

describe("internal manual sync route auth (GH #455)", () => {
  it("rejects an unauthenticated manual sync POST", async () => {
    const app = Fastify();
    const services = createServices();
    await registerInternalRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/sync/orders/order-1?merchantId=merchant-1"
      });

      expect(response.statusCode).toBe(401);
      expect(services.queue.enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a manual sync POST with the wrong bearer token", async () => {
    const app = Fastify();
    const services = createServices();
    await registerInternalRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/sync/orders/order-1?merchantId=merchant-1",
        headers: { authorization: "Bearer not-the-token" }
      });

      expect(response.statusCode).toBe(401);
      expect(services.queue.enqueue).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("enqueues a manual sync with the configured bearer token", async () => {
    const app = Fastify();
    const services = createServices();
    await registerInternalRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal/sync/orders/order-1?merchantId=merchant-1",
        headers: { authorization: "Bearer internal-admin-token-0123456789" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, enqueued: true });
      expect(services.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: OrderProvider.CLOVER,
          merchantId: "merchant-1",
          sourceOrderId: "order-1",
          reason: "manual"
        })
      );
    } finally {
      await app.close();
    }
  });
});
