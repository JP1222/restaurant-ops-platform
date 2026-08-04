import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { initializeAppServices } from "../src/app.js";

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
    cloverWebhookAuthCode: undefined,
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

describe("initializeAppServices", () => {
  it("runs Clover env bootstrap in production when static token mode is configured", async () => {
    const services = {
      config: makeConfig({ nodeEnv: "production", cloverMerchantId: "env-merchant", cloverToken: "env-token" }),
      auth: {
        bootstrapAdminAccount: vi.fn(async () => undefined)
      },
      clover: {
        bootstrapMerchantFromEnv: vi.fn(async () => undefined),
        // GH #170: boot-time token validation probes the merchant profile.
        fetchMerchant: vi.fn(async () => ({ id: "env-merchant" }))
      },
      prisma: {
        // provisionTenant (ADR-0818 / #902) reconciles tenant-default on boot;
        // findUnique returns it as existing so create is skipped.
        tenant: {
          findUnique: vi.fn(async () => ({ id: "tenant-default" }))
        },
        providerAppState: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async () => undefined)
        },
        cloverMerchant: {
          findUnique: vi.fn(async () => null),
          findFirst: vi.fn(async () => null)
        }
      },
      hub: {
        start: vi.fn(async () => undefined)
      }
    } as never;

    await initializeAppServices(services);

    expect(services.auth.bootstrapAdminAccount).toHaveBeenCalledTimes(1);
    expect(services.clover.bootstrapMerchantFromEnv).toHaveBeenCalledTimes(1);
    // providerAppState.findUnique is hit once by bootstrap and once by the
    // startup-validation merchant resolution.
    expect(services.prisma.providerAppState.findUnique).toHaveBeenCalledTimes(2);
    expect(services.prisma.providerAppState.upsert).toHaveBeenCalledTimes(1);
    // GH #170: the configured token is validated against the merchant profile.
    expect(services.clover.fetchMerchant).toHaveBeenCalledWith("env-merchant");
    expect(services.hub.start).toHaveBeenCalledTimes(1);
  });

  it("skips Clover env bootstrap when no static token mode is configured", async () => {
    const services = {
      config: makeConfig({ nodeEnv: "development", cloverMerchantId: undefined, cloverToken: undefined }),
      auth: {
        bootstrapAdminAccount: vi.fn(async () => undefined)
      },
      clover: {
        bootstrapMerchantFromEnv: vi.fn(async () => undefined),
        fetchMerchant: vi.fn(async () => ({}))
      },
      prisma: {
        // provisionTenant (ADR-0818 / #902) reconciles tenant-default on boot;
        // findUnique returns it as existing so create is skipped.
        tenant: {
          findUnique: vi.fn(async () => ({ id: "tenant-default" }))
        },
        providerAppState: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async () => undefined)
        },
        cloverMerchant: {
          findUnique: vi.fn(async () => null),
          findFirst: vi.fn(async () => null)
        }
      },
      hub: {
        start: vi.fn(async () => undefined)
      }
    } as never;

    await initializeAppServices(services);

    expect(services.auth.bootstrapAdminAccount).toHaveBeenCalledTimes(1);
    expect(services.clover.bootstrapMerchantFromEnv).not.toHaveBeenCalled();
    // Bootstrap does not query provider state without static token mode; startup
    // validation still resolves a merchant (provider state + first-merchant
    // lookup) but finds none, so it skips the probe entirely.
    expect(services.prisma.providerAppState.findUnique).toHaveBeenCalledTimes(1);
    expect(services.prisma.providerAppState.upsert).not.toHaveBeenCalled();
    expect(services.clover.fetchMerchant).not.toHaveBeenCalled();
    expect(services.hub.start).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite an existing token-mode merchant selection", async () => {
    const services = {
      config: makeConfig({ nodeEnv: "production", cloverMerchantId: "env-merchant", cloverToken: "env-token" }),
      auth: {
        bootstrapAdminAccount: vi.fn(async () => undefined)
      },
      clover: {
        bootstrapMerchantFromEnv: vi.fn(async () => undefined),
        fetchMerchant: vi.fn(async () => ({ id: "merchant-9" }))
      },
      prisma: {
        // provisionTenant (ADR-0818 / #902) reconciles tenant-default on boot;
        // findUnique returns it as existing so create is skipped.
        tenant: {
          findUnique: vi.fn(async () => ({ id: "tenant-default" }))
        },
        providerAppState: {
          findUnique: vi.fn(async () => ({ tokenModeMerchantId: "merchant-9" })),
          upsert: vi.fn(async () => undefined)
        },
        cloverMerchant: {
          findUnique: vi.fn(async () => ({ id: "merchant-9" })),
          findFirst: vi.fn(async () => null)
        }
      },
      hub: {
        start: vi.fn(async () => undefined)
      }
    } as never;

    await initializeAppServices(services);

    expect(services.clover.bootstrapMerchantFromEnv).toHaveBeenCalledTimes(1);
    expect(services.prisma.providerAppState.findUnique).toHaveBeenCalledTimes(2);
    expect(services.prisma.providerAppState.upsert).not.toHaveBeenCalled();
    // Startup validation resolves to the existing token-mode merchant and probes it.
    expect(services.clover.fetchMerchant).toHaveBeenCalledWith("merchant-9");
    expect(services.hub.start).toHaveBeenCalledTimes(1);
  });

  it("provisions tenant-default and ensures a membership for the bootstrap admin (#902)", async () => {
    const ensureTenantMembership = vi.fn(async () => undefined);
    const tenantCreate = vi.fn(async () => undefined);
    const services = {
      config: makeConfig({ nodeEnv: "development", cloverMerchantId: undefined, cloverToken: undefined }),
      auth: {
        bootstrapAdminAccount: vi.fn(async () => ({ id: "acct_1", role: "OWNER" })),
        ensureTenantMembership
      },
      clover: {
        bootstrapMerchantFromEnv: vi.fn(async () => undefined),
        fetchMerchant: vi.fn(async () => ({}))
      },
      prisma: {
        tenant: {
          findUnique: vi.fn(async () => ({ id: "tenant-default" })),
          create: tenantCreate
        },
        providerAppState: {
          findUnique: vi.fn(async () => null),
          upsert: vi.fn(async () => undefined)
        },
        cloverMerchant: {
          findUnique: vi.fn(async () => null),
          findFirst: vi.fn(async () => null)
        }
      },
      hub: {
        start: vi.fn(async () => undefined)
      }
    } as never;

    await initializeAppServices(services);

    // tenant-default already exists → no create; the bootstrap admin gets a
    // membership so a fresh install never relies on the env-default fallback.
    expect(tenantCreate).not.toHaveBeenCalled();
    expect(ensureTenantMembership).toHaveBeenCalledWith({
      accountId: "acct_1",
      tenantId: "tenant-default",
      role: "OWNER"
    });
  });
});
