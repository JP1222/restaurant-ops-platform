import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { CLOVER_ADMIN_PATH } from "../src/lib/clover-admin.js";
import { makeOauthState, readOauthState } from "../src/lib/crypto.js";
import { registerCloverRoutes } from "../src/routes/clover.js";

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

function createTestContext(configOverrides: Partial<AppConfig> = {}) {
  const knownMerchants = new Set(["merchant-1"]);
  // L1 dedup key mirrors the schema's @@unique([merchantId, eventId]) (GH #129),
  // NOT the content fingerprint.
  const webhookEventKeys = new Set<string>();
  const providerEvents = new Map<string, Record<string, unknown>>();
  const jobs: Array<Record<string, unknown>> = [];
  let providerAppState: Record<string, unknown> | null = null;

  const services = {
    config: makeConfig(configOverrides),
    clover: {
      buildAuthorizeUrl: vi.fn((state: string, merchantId?: string) => {
        const params = new URLSearchParams({ state });
        if (merchantId) {
          params.set("merchantId", merchantId);
        }
        return `https://www.clover.com/oauth/v2/authorize?${params.toString()}`;
      }),
      exchangeAuthorizationCode: vi.fn(),
      bootstrapMerchantFromEnv: vi.fn(async () => {})
    },
    queue: {
      enqueueBulk: vi.fn(async (nextJobs: Record<string, unknown>[]) => {
        jobs.push(...nextJobs);
      })
    },
    prisma: {
      cloverMerchant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          knownMerchants.has(where.id) ? { id: where.id } : null
        ),
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => knownMerchants.has(id)).map((id) => ({ id }))
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data
        })),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      cloverWebhookEvent: {
        createMany: vi.fn(async ({ data }: { data: Array<{ merchantId: string; eventId: string }> }) => {
          let count = 0;
          for (const row of data) {
            const key = `${row.merchantId}:${row.eventId}`;
            if (webhookEventKeys.has(key)) {
              continue;
            }
            webhookEventKeys.add(key);
            count += 1;
          }
          return { count };
        })
      },
      kdsProviderEvent: {
        createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown> & { fingerprint: string }> }) => {
          let count = 0;
          for (const row of data) {
            if (providerEvents.has(row.fingerprint)) {
              continue;
            }
            count += 1;
            providerEvents.set(row.fingerprint, {
              id: `provider-event-${count}`,
              ...row,
              status: "RECEIVED",
              queuedAt: null,
              receivedAt: row.receivedAt ?? new Date()
            });
          }
          return { count };
        }),
        findMany: vi.fn(async ({ where }: { where: { fingerprint: { in: string[] } } }) =>
          where.fingerprint.in
            .map((fingerprint) => providerEvents.get(fingerprint))
            .filter(Boolean)
        ),
        updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
          for (const event of providerEvents.values()) {
            if (where.id.in.includes(event.id as string)) {
              Object.assign(event, data);
            }
          }
          return { count: where.id.in.length };
        })
      },
      providerAppState: {
        findUnique: vi.fn(async () => providerAppState),
        upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          providerAppState = {
            ...(providerAppState ?? create),
            ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined))
          };
          return providerAppState;
        })
      },
      deadLetterJob: {
        count: vi.fn(async () => 0)
      },
      kdsTicket: {
        groupBy: vi.fn(async () => [])
      }
    }
  } as never;

  return { services, jobs };
}

async function buildRouteApp(configOverrides: Partial<AppConfig> = {}) {
  const context = createTestContext(configOverrides);
  const app = Fastify();
  await registerCloverRoutes(app as never, context.services);
  return { app, ...context };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clover routes", () => {
  it("defaults install returnTo to the Clover admin console", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/clover/install"
      });

      expect(response.statusCode).toBe(302);
      expect(services.clover.buildAuthorizeUrl).toHaveBeenCalledTimes(1);
      const state = vi.mocked(services.clover.buildAuthorizeUrl).mock.calls[0]?.[0];
      const decoded = readOauthState(services.config.sessionSecret, state);
      expect(decoded.returnTo).toBe(CLOVER_ADMIN_PATH);
    } finally {
      await app.close();
    }
  });

  it("keeps the configured token-mode merchant in Clover install redirects", async () => {
    const { app, services } = await buildRouteApp({
      nodeEnv: "production",
      cloverMerchantId: "env-merchant",
      cloverToken: "env-token"
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/clover/install"
      });

      expect(response.statusCode).toBe(302);
      expect(services.clover.buildAuthorizeUrl).toHaveBeenCalledWith(expect.any(String), "env-merchant");
      const state = vi.mocked(services.clover.buildAuthorizeUrl).mock.calls[0]?.[0];
      const decoded = readOauthState(services.config.sessionSecret, state);
      expect(decoded.merchantId).toBe("env-merchant");
    } finally {
      await app.close();
    }
  });

  it("redirects successful OAuth callbacks back to the Clover admin console", async () => {
    const { app, services } = await buildRouteApp();
    const state = makeOauthState(services.config.sessionSecret, {
      merchantId: "merchant-1",
      returnTo: CLOVER_ADMIN_PATH
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/clover/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`
      });

      expect(response.statusCode).toBe(302);
      expect(services.clover.exchangeAuthorizationCode).toHaveBeenCalledWith("test-code", "merchant-1");
      expect(response.headers.location).toBe("https://kds.example.com/admin/integrations/clover?merchantId=merchant-1&connected=1");
    } finally {
      await app.close();
    }
  });

  it("redirects failed OAuth callbacks back to the admin console with an error", async () => {
    const { app, services } = await buildRouteApp();
    const state = makeOauthState(services.config.sessionSecret, {
      merchantId: "merchant-1",
      returnTo: CLOVER_ADMIN_PATH
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/clover/oauth/callback?state=${encodeURIComponent(state)}`
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://kds.example.com/admin/integrations/clover?merchantId=merchant-1&oauthError=missing_authorization_code");
    } finally {
      await app.close();
    }
  });

  it("stores Clover webhook verification codes without requiring the auth header", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        payload: {
          verificationCode: "verify-123"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        verificationCodeReceived: true
      });
      expect(services.prisma.providerAppState.upsert).toHaveBeenCalledTimes(1);
      expect(services.prisma.providerAppState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            latestWebhookVerificationCode: "verify-123"
          })
        })
      );
    } finally {
      await app.close();
    }
  });

  it("rejects an anonymous webhook in production when no auth code is configured (GH #454)", async () => {
    const { app, services, jobs } = await buildRouteApp({
      nodeEnv: "production",
      cloverWebhookAuthCode: undefined
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        payload: {
          merchants: { "merchant-1": [{ objectId: "O:order-454", type: "CREATE", ts: 1776800000000 }] }
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Clover webhook auth code is not configured." });
      // Nothing was enqueued or persisted — the request was rejected at the gate.
      expect(jobs).toHaveLength(0);
      expect(services.prisma.cloverWebhookEvent.createMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("still accepts the verification handshake in production with no auth code (GH #454)", async () => {
    // The handshake returns before the auth gate, so URL verification keeps working.
    const { app } = await buildRouteApp({ nodeEnv: "production", cloverWebhookAuthCode: undefined });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        payload: { verificationCode: "verify-prod" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, verificationCodeReceived: true });
    } finally {
      await app.close();
    }
  });

  it("stays permissive outside production when no auth code is configured (GH #454)", async () => {
    // Dev/sandbox must not require a secret for local testing.
    const { app, jobs } = await buildRouteApp({
      nodeEnv: "development",
      cloverWebhookAuthCode: undefined
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        payload: {
          merchants: { "merchant-1": [{ objectId: "O:order-dev", type: "CREATE", ts: 1776800000000 }] }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(jobs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("serves the same handler at the /webhooks/clover canonical alias", async () => {
    const { app, services, jobs } = await buildRouteApp();

    try {
      const verifyResponse = await app.inject({
        method: "POST",
        url: "/webhooks/clover",
        payload: { verificationCode: "verify-from-alias" }
      });
      expect(verifyResponse.statusCode).toBe(200);
      expect(verifyResponse.json()).toEqual({
        ok: true,
        verificationCodeReceived: true
      });
      expect(services.prisma.providerAppState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            latestWebhookVerificationCode: "verify-from-alias"
          })
        })
      );

      const orderResponse = await app.inject({
        method: "POST",
        url: "/webhooks/clover",
        headers: { "x-clover-auth": "webhook-secret" },
        payload: {
          merchantId: "merchant-1",
          orderId: "order-alias",
          type: "UPDATE",
          modifiedTime: 1776810000000
        }
      });
      expect(orderResponse.statusCode).toBe(200);
      expect(jobs).toMatchObject([
        {
          provider: "CLOVER",
          merchantId: "merchant-1",
          sourceOrderId: "order-alias",
          reason: "webhook"
        }
      ]);
    } finally {
      await app.close();
    }
  });

  it("accepts x-clover-auth and enqueues order updates from Clover batch payloads", async () => {
    const { app, services, jobs } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: {
          "x-clover-auth": "webhook-secret"
        },
        payload: {
          appId: "app-1",
          merchants: {
            "merchant-1": [
              {
                objectId: "O:order-1",
                type: "CREATE",
                ts: 1776800000000
              },
              {
                objectId: "I:item-9",
                type: "UPDATE",
                ts: 1776800000000
              }
            ]
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        enqueued: 1,
        deduped: 0,
        ignored: 0
      });
      expect(jobs).toMatchObject([
        {
          provider: "CLOVER",
          merchantId: "merchant-1",
          sourceOrderId: "order-1",
          reason: "webhook"
        }
      ]);
      expect(services.prisma.cloverWebhookEvent.createMany).toHaveBeenCalledTimes(1);
      expect(services.prisma.cloverMerchant.updateMany).toHaveBeenCalledTimes(1);
      expect(services.prisma.providerAppState.upsert).toHaveBeenCalledTimes(1);
      expect(services.prisma.providerAppState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            lastSignedWebhookAt: expect.any(Date)
          })
        })
      );
    } finally {
      await app.close();
    }
  });

  it("returns 503 (not 200) when enqueue fails, so Clover redelivers (GH #460)", async () => {
    const { app, services } = await buildRouteApp();
    // Force the enqueue to fail after the event is accepted/persisted.
    services.queue.enqueueBulk = vi.fn(async () => {
      throw new Error("redis unavailable");
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: { "x-clover-auth": "webhook-secret" },
        payload: {
          merchants: {
            "merchant-1": [{ objectId: "O:order-460", type: "CREATE", ts: 1776800000000 }]
          }
        }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, error: "enqueue_failed" });
      // A 200 here would tell Clover the event was accepted and it would never resend.
    } finally {
      await app.close();
    }
  });

  it("accepts the legacy x-clover-auth-code header alias", async () => {
    const { app, jobs } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: {
          "x-clover-auth-code": "webhook-secret"
        },
        payload: {
          merchantId: "merchant-1",
          orderId: "order-2",
          type: "UPDATE",
          modifiedTime: 1776803600000
        }
      });

      expect(response.statusCode).toBe(200);
      expect(jobs).toMatchObject([
        {
          provider: "CLOVER",
          merchantId: "merchant-1",
          sourceOrderId: "order-2",
          reason: "webhook"
        }
      ]);
    } finally {
      await app.close();
    }
  });

  it("dedupes repeated identical webhook deliveries by eventId", async () => {
    const { app, jobs } = await buildRouteApp();
    const payload = {
      merchantId: "merchant-1",
      eventId: "evt-order-3",
      orderId: "order-3",
      type: "UPDATE",
      modifiedTime: 1776807200000
    };

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: {
          "x-clover-auth": "webhook-secret"
        },
        payload
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: {
          "x-clover-auth": "webhook-secret"
        },
        payload
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({
        ok: true,
        enqueued: 0,
        deduped: 1,
        ignored: 0
      });
      expect(jobs).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // GH #129 acceptance: a resend that carries the SAME eventId but a DIFFERENT
  // modifiedTime (so the old content fingerprint would differ) must still be
  // rejected at the L1 (merchantId, eventId) dedup layer. Under the old
  // fingerprint key this second delivery slipped through and double-persisted.
  it("dedupes a re-delivery with the same eventId but a different modifiedTime", async () => {
    const { app, services } = await buildRouteApp();

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: { "x-clover-auth": "webhook-secret" },
        payload: {
          merchantId: "merchant-1",
          eventId: "evt-stable-1",
          orderId: "order-resend",
          type: "UPDATE",
          modifiedTime: 1776807200000
        }
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: { "x-clover-auth": "webhook-secret" },
        payload: {
          merchantId: "merchant-1",
          eventId: "evt-stable-1",
          orderId: "order-resend",
          type: "UPDATE",
          // Different modifiedTime => different content fingerprint, but the
          // eventId is unchanged, so L1 must still collapse it.
          modifiedTime: 1776807900000
        }
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      // L1 layer: both deliveries hit createMany, but the second inserts 0 rows
      // because (merchantId, eventId) already exists.
      const createMany = services.prisma.cloverWebhookEvent.createMany as ReturnType<typeof vi.fn>;
      expect(createMany).toHaveBeenCalledTimes(2);
      const firstInserted = await createMany.mock.results[0].value;
      const secondInserted = await createMany.mock.results[1].value;
      expect(firstInserted.count).toBe(1);
      expect(secondInserted.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("ignores non-order Clover webhook events", async () => {
    const { app, jobs } = await buildRouteApp();

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/clover/webhooks",
        headers: {
          "x-clover-auth": "webhook-secret"
        },
        payload: {
          appId: "app-1",
          merchants: {
            "merchant-1": [
              {
                objectId: "I:item-9",
                type: "UPDATE",
                ts: 1776800000000
              }
            ]
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        ignored: true
      });
      expect(jobs).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
