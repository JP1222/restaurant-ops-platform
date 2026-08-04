import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  getCloverStartupValidation,
  resetCloverStartupValidation,
  validateCloverTokenAtStartup
} from "../src/lib/clover-startup-validation.js";
import { kdsCloverStartupValidationStatus } from "../src/lib/metrics.js";

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
  } as AppConfig;
}

// prisma shape exercised by resolveDefaultCloverMerchantId. By default: no
// provider-state selection and no merchant rows.
function createPrisma(overrides: {
  tokenModeMerchantId?: string | null;
  merchantById?: string | null;
  firstMerchantId?: string | null;
} = {}) {
  return {
    providerAppState: {
      findUnique: vi.fn(async () => ({ tokenModeMerchantId: overrides.tokenModeMerchantId ?? null }))
    },
    cloverMerchant: {
      findUnique: vi.fn(async () => (overrides.merchantById ? { id: overrides.merchantById } : null)),
      findFirst: vi.fn(async () => (overrides.firstMerchantId ? { id: overrides.firstMerchantId } : null))
    }
  } as never;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn()
  };
}

beforeEach(() => {
  resetCloverStartupValidation();
  kdsCloverStartupValidationStatus.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateCloverTokenAtStartup (GH #170)", () => {
  it("reports pass and sets the gauge to 1 when the merchant probe succeeds", async () => {
    const prisma = createPrisma();
    const clover = { fetchMerchant: vi.fn(async () => ({ id: "env-merchant", name: "Test" })) };
    const logger = createLogger();
    const config = makeConfig({ cloverMerchantId: "env-merchant", cloverToken: "env-token" });

    const result = await validateCloverTokenAtStartup(prisma, config, clover, logger);

    expect(clover.fetchMerchant).toHaveBeenCalledWith("env-merchant");
    expect(result).toMatchObject({ state: "ok", merchantId: "env-merchant" });
    expect(getCloverStartupValidation()).toMatchObject({ state: "ok", merchantId: "env-merchant" });
    expect(logger.info).toHaveBeenCalled();

    const metric = await kdsCloverStartupValidationStatus.get();
    const sample = metric.values.find((value) => value.labels.merchant === "env-merchant");
    expect(sample?.value).toBe(1);
  });

  it("reports failure and sets the gauge to 0 when the probe throws", async () => {
    const prisma = createPrisma();
    const clover = {
      fetchMerchant: vi.fn(async () => {
        throw new Error("Clover request failed with 401 for /v3/merchants/env-merchant.");
      })
    };
    const logger = createLogger();
    const config = makeConfig({ cloverMerchantId: "env-merchant", cloverToken: "stale-token" });

    const result = await validateCloverTokenAtStartup(prisma, config, clover, logger);

    expect(result).toMatchObject({ state: "failed", merchantId: "env-merchant" });
    expect((result as { reason: string }).reason).toContain("401");
    expect(getCloverStartupValidation()).toMatchObject({ state: "failed" });
    expect(logger.warn).toHaveBeenCalled();

    const metric = await kdsCloverStartupValidationStatus.get();
    const sample = metric.values.find((value) => value.labels.merchant === "env-merchant");
    expect(sample?.value).toBe(0);
  });

  it("skips validation (no probe, no metric) when no merchant is configured", async () => {
    const prisma = createPrisma();
    const clover = { fetchMerchant: vi.fn(async () => ({})) };
    const logger = createLogger();
    const config = makeConfig();

    const result = await validateCloverTokenAtStartup(prisma, config, clover, logger);

    expect(clover.fetchMerchant).not.toHaveBeenCalled();
    expect(result).toMatchObject({ state: "skipped" });
    expect(getCloverStartupValidation()).toMatchObject({ state: "skipped" });

    const metric = await kdsCloverStartupValidationStatus.get();
    expect(metric.values).toHaveLength(0);
  });

  it("does not throw when the probe rejects (boot must continue)", async () => {
    const prisma = createPrisma();
    const clover = {
      fetchMerchant: vi.fn(async () => {
        throw new Error("network down");
      })
    };
    const config = makeConfig({ cloverMerchantId: "env-merchant", cloverToken: "env-token" });

    await expect(
      validateCloverTokenAtStartup(prisma, config, clover, createLogger())
    ).resolves.toMatchObject({ state: "failed" });
  });
});
