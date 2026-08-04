import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  canBootstrapCloverMerchantFromEnv,
  getConfiguredCloverMerchantId,
  getConfiguredCloverToken,
  resolveDefaultCloverMerchantId
} from "../src/lib/clover-runtime.js";

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

describe("clover-runtime", () => {
  it("enables env bootstrap whenever both merchant id and token are configured", () => {
    expect(canBootstrapCloverMerchantFromEnv(makeConfig({ nodeEnv: "development" }))).toBe(false);
    expect(
      canBootstrapCloverMerchantFromEnv(
        makeConfig({ nodeEnv: "development", cloverMerchantId: "env-merchant", cloverToken: "env-token" })
      )
    ).toBe(true);
    expect(
      canBootstrapCloverMerchantFromEnv(
        makeConfig({ nodeEnv: "production", cloverMerchantId: "env-merchant", cloverToken: "env-token" })
      )
    ).toBe(true);
  });

  it("keeps configured merchant credentials available in production token mode", () => {
    const config = makeConfig({
      nodeEnv: "production",
      cloverMerchantId: "env-merchant",
      cloverToken: "env-token"
    });

    expect(getConfiguredCloverMerchantId(config)).toBe("env-merchant");
    expect(getConfiguredCloverToken(config)).toBe("env-token");
  });

  it("resolves the default merchant from the database when no configured token mode exists", async () => {
    const prisma = {
      providerAppState: {
        findUnique: vi.fn(async () => null)
      },
      cloverMerchant: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ id: "merchant-from-db" }))
      }
    };

    const merchantId = await resolveDefaultCloverMerchantId(
      prisma as never,
      makeConfig({
        nodeEnv: "production"
      }),
      undefined
    );

    expect(merchantId).toBe("merchant-from-db");
    expect(prisma.providerAppState.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.cloverMerchant.findFirst).toHaveBeenCalledWith({
      select: { id: true },
      orderBy: { updatedAt: "desc" }
    });
  });

  it("prefers the persisted token-mode merchant selection before env fallback", async () => {
    const prisma = {
      providerAppState: {
        findUnique: vi.fn(async () => ({ tokenModeMerchantId: "merchant-selected" }))
      },
      cloverMerchant: {
        findUnique: vi.fn(async () => ({ id: "merchant-selected" })),
        findFirst: vi.fn(async () => ({ id: "merchant-from-db" }))
      }
    };

    const merchantId = await resolveDefaultCloverMerchantId(
      prisma as never,
      makeConfig({
        nodeEnv: "production",
        cloverMerchantId: "env-merchant",
        cloverToken: "env-token"
      }),
      undefined
    );

    expect(merchantId).toBe("merchant-selected");
    expect(prisma.cloverMerchant.findUnique).toHaveBeenCalledWith({
      where: { id: "merchant-selected" },
      select: { id: true }
    });
    expect(prisma.cloverMerchant.findFirst).not.toHaveBeenCalled();
  });

  it("prefers env token mode before falling back to the database", async () => {
    const prisma = {
      providerAppState: {
        findUnique: vi.fn(async () => null)
      },
      cloverMerchant: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ id: "merchant-from-db" }))
      }
    };

    const config = makeConfig({
      nodeEnv: "development",
      cloverMerchantId: "env-merchant",
      cloverToken: "env-token"
    });

    await expect(resolveDefaultCloverMerchantId(prisma as never, config, undefined)).resolves.toBe("env-merchant");
    expect(prisma.cloverMerchant.findFirst).not.toHaveBeenCalled();
  });
});
