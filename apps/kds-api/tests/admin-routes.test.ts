import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import { WEB_SESSION_COOKIE_NAME } from "../src/lib/web-auth.js";

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
    cloverBaseUrl: "https://apisandbox.dev.clover.com",
    cloverRegion: "US",
    cloverMerchantId: undefined,
    cloverToken: undefined,
    cloverAppId: "app-id",
    cloverAppSecret: "app-secret",
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

function createServices(configOverrides: Partial<AppConfig> = {}) {
  const heartbeatPayload = JSON.stringify({
    workerId: "worker-1",
    pid: 1234,
    host: "test-host",
    at: "2026-04-22T06:19:00.000Z"
  });
  const session = {
    accountId: "account-1",
    username: "admin",
    displayName: "Kitchen Admin",
    role: "ADMIN",
    issuedAt: "2026-04-22T06:00:00.000Z",
    lastSeenAt: "2026-04-22T06:00:00.000Z"
  };

  const cloverMerchant = {
    findUnique: vi.fn(async () => ({
      id: "merchant-1",
      authStatus: "ACTIVE",
      refreshTokenExpiresAt: new Date("2026-05-22T06:00:00.000Z"),
      appInstalledAt: new Date("2026-04-22T06:05:00.000Z"),
      lastWebhookAt: new Date("2026-04-22T06:14:00.000Z"),
      lastSyncAt: new Date("2026-04-22T06:15:00.000Z"),
      lastReconciledAt: new Date("2026-04-22T06:16:00.000Z"),
      updatedAt: new Date("2026-04-22T06:18:00.000Z"),
      webhookStatus: "healthy"
    })),
    findFirst: vi.fn(async () => ({
      id: "merchant-1",
      authStatus: "ACTIVE",
      refreshTokenExpiresAt: new Date("2026-05-22T06:00:00.000Z"),
      appInstalledAt: new Date("2026-04-22T06:05:00.000Z"),
      lastWebhookAt: new Date("2026-04-22T06:14:00.000Z"),
      lastSyncAt: new Date("2026-04-22T06:15:00.000Z"),
      lastReconciledAt: new Date("2026-04-22T06:16:00.000Z"),
      updatedAt: new Date("2026-04-22T06:18:00.000Z"),
      webhookStatus: "healthy"
    })),
    upsert: vi.fn(async ({ where, create, update }: any) => ({
      id: where.id,
      ...create,
      ...update
    })),
    updateMany: vi.fn(async () => ({ count: 1 }))
  };

  const providerAppState = {
    findUnique: vi.fn(async () => ({
      provider: "CLOVER",
      environment: "STAGING",
      latestWebhookVerificationCode: "verify-123",
      latestWebhookVerificationAt: new Date("2026-04-22T06:10:00.000Z"),
      lastSignedWebhookAt: new Date("2026-04-22T06:12:00.000Z"),
      tokenModeMerchantId: "merchant-1"
    })),
    upsert: vi.fn(async ({ create, update }: any) => ({
      ...create,
      ...update
    }))
  };

  const transactionClient = {
    cloverMerchant,
    providerAppState
  };

  return {
    config: makeConfig({
      cloverMerchantId: "merchant-1",
      cloverToken: "static-token",
      ...configOverrides
    }),
    auth: {
      readSession: vi.fn(async (sessionId: string | undefined) => (sessionId === "session-1" ? session : null)),
      getAccountById: vi.fn(async (accountId: string) =>
        accountId === "account-1"
          ? {
              id: "account-1",
              username: "admin",
              displayName: "Kitchen Admin",
              role: "ADMIN"
            }
          : null
      ),
      destroySession: vi.fn(async () => undefined),
      getSessionCookieOptions: vi.fn(() => ({
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const
      }))
    },
    prisma: {
      providerAppState,
      cloverMerchant,
      deadLetterJob: {
        count: vi.fn(async () => 2),
        groupBy: vi.fn(async () => [
          { jobType: "sync-order", _count: { _all: 2 } }
        ]),
        findFirst: vi.fn(async () => ({
          jobType: "sync-order",
          reason: "Clover API timeout",
          createdAt: new Date("2026-04-22T06:17:00.000Z")
        }))
      },
      kdsRealtimeReceipt: {
        findMany: vi.fn(async () => [])
      },
      kdsTicket: {
        groupBy: vi.fn(async () => [
          { status: "NEW", _count: { _all: 3 } },
          { status: "READY", _count: { _all: 1 } }
        ])
      },
      $queryRawUnsafe: vi.fn(async () => [{ ok: 1 }]),
      $transaction: vi.fn(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient))
    },
    redisPublisher: {
      ping: vi.fn(async () => "PONG"),
      keys: vi.fn(async () => ["kds:worker:worker-1:heartbeat"]),
      mget: vi.fn(async () => [heartbeatPayload])
    },
    queue: {
      depths: vi.fn(async () => ({
        syncHi: 0,
        syncLo: 0,
        fulfillment: 0,
        scheduler: 1
      })),
      oldestWaitMs: vi.fn(async () => ({
        syncHi: null,
        syncLo: null,
        fulfillment: null,
        scheduler: 250
      }))
    }
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin routes", () => {
  it("301 redirects /admin to Backoffice /admin/devices (Phase 4.5 closeout)", async () => {
    const app = Fastify();
    await app.register(cookie);
    const services = createServices({ backofficeBaseUrl: "https://backoffice.example.com" });
    await registerAdminRoutes(app as never, services);

    try {
      const response = await app.inject({ method: "GET", url: "/admin" });
      expect(response.statusCode).toBe(301);
      expect(response.headers.location).toBe("https://backoffice.example.com/admin/devices");
    } finally {
      await app.close();
    }
  });

  it("301 redirects the legacy Clover console path to Backoffice /admin/integrations", async () => {
    const app = Fastify();
    await app.register(cookie);
    const services = createServices({ backofficeBaseUrl: "https://backoffice.example.com" });
    await registerAdminRoutes(app as never, services);

    try {
      const response = await app.inject({ method: "GET", url: "/admin/integrations/clover" });
      expect(response.statusCode).toBe(301);
      expect(response.headers.location).toBe(
        "https://backoffice.example.com/admin/integrations"
      );
    } finally {
      await app.close();
    }
  });

  it("redirects unauthenticated system status requests to /login", async () => {
    const app = Fastify();
    await app.register(cookie);
    await registerAdminRoutes(app as never, createServices());

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/system-status?merchantId=merchant-1"
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("/login?returnTo=%2Fapi%2Fadmin%2Fsystem-status%3FmerchantId%3Dmerchant-1");
    } finally {
      await app.close();
    }
  });

  it("returns protected system monitor JSON with empty latency state", async () => {
    const app = Fastify();
    await app.register(cookie);
    const services = createServices();
    await registerAdminRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/system-status?merchantId=merchant-1",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        overall: {
          status: "degraded"
        },
        health: {
          db: {
            ok: true
          },
          redis: {
            ok: true
          },
          workers: {
            online: 1
          }
        },
        latency: {
          empty: true,
          sampleCount: 0
        },
        risk: {
          deadLettersTotal: 2
        }
      });
      expect(services.prisma.kdsRealtimeReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          merchantId: "merchant-1"
        })
      }));
    } finally {
      await app.close();
    }
  });

  it("calculates system monitor latency percentiles from recent samples", async () => {
    const app = Fastify();
    await app.register(cookie);
    const services = createServices();
    vi.mocked(services.prisma.deadLetterJob.groupBy).mockResolvedValue([]);
    vi.mocked(services.prisma.deadLetterJob.findFirst).mockResolvedValue(null);
    vi.mocked(services.prisma.kdsRealtimeReceipt.findMany).mockResolvedValue([
      {
        webhookToRenderMs: 100,
        realtimeToBrowserMs: 30,
        browserRenderMs: 5,
        createdAt: new Date("2026-04-22T06:18:00.000Z")
      },
      {
        webhookToRenderMs: 900,
        realtimeToBrowserMs: 50,
        browserRenderMs: 8,
        createdAt: new Date("2026-04-22T06:18:01.000Z")
      },
      {
        webhookToRenderMs: 2_500,
        realtimeToBrowserMs: 70,
        browserRenderMs: 10,
        createdAt: new Date("2026-04-22T06:18:02.000Z")
      }
    ] as never);
    await registerAdminRoutes(app as never, services);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/admin/system-status?merchantId=merchant-1",
        headers: {
          cookie: `${WEB_SESSION_COOKIE_NAME}=session-1`
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        overall: {
          status: "healthy"
        },
        latency: {
          empty: false,
          sampleCount: 3,
          webhookToBoard: {
            p50Ms: 900,
            p95Ms: 2500,
            p99Ms: 2500
          }
        }
      });
    } finally {
      await app.close();
    }
  });
});
