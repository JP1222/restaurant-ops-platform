/**
 * Phase 4.5.4 — kds-api role-gated board-settings writes.
 *
 * The Floor's PUT /api/kds/settings runs unauthenticated at the kds-api
 * boundary today (the route is identified by which endpoint was hit, not by
 * a session-role discriminator on the request). The Backoffice's
 * PUT /api/admin/kds/board-settings runs behind the
 * KDS_INTERNAL_ADMIN_TOKEN bearer guard.
 *
 * These tests assert that the persistence layer (saveBoardSettings) respects
 * the "role" argument the route layer passes in:
 *   - role: "floor" → operator-config + Deliverect provider fields are
 *     stripped from the write so a malicious or buggy Floor client cannot
 *     promote stale or attacker-controlled values into the DB.
 *   - role: "admin" → all fields accepted, including Deliverect plaintext
 *     fallback writes through buildDeliverectProviderUpsert (the legacy
 *     full-shape write path; the editor-facing
 *     /api/admin/kds/integrations/deliverect endpoint added in Step 4.5.2 is
 *     the path that writes the encrypted cipher columns).
 */

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KitchenBoardSettings } from "@rop/contracts";
import type { AppConfig } from "../src/config.js";
import { saveBoardSettings } from "../src/lib/board-settings-service.js";
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
    cloverMerchantId: "merchant-1",
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

interface MockTx {
  kdsFilter: {
    upsert: ReturnType<typeof vi.fn>;
  };
  kdsProviderConfig: {
    upsert: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
}

function createServices(existingProvider: Record<string, unknown> | null = null) {
  const kdsFilterStored: Record<string, unknown> = {
    merchantId: "merchant-1",
    boardSettings: {
      boardTimeZone: "America/Chicago",
      dailyResetEnabled: true,
      dailyResetTime: "21:00",
      urgencyWarningMinutes: 10,
      urgencyCriticalMinutes: 20,
      urgencyBlinkCritical: true,
      modifierDangerKeywords: ["allergy"],
      modifierAccentKeywords: ["extra"],
      display: {
        weather: {
          enabled: true,
          zipCode: "00000",
          countryCode: "US",
          unit: "fahrenheit"
        }
      }
    },
    allowedOrderTypes: [],
    blockedSources: [],
    paymentStates: [],
    createdAfterMinutes: null,
    searchText: "",
    includeCompleted: false,
    soundEnabled: true,
    screenPinEnabled: false
  };

  const providerStored: Record<string, unknown> | null = existingProvider ?? {
    merchantId: "merchant-1",
    provider: "DELIVERECT",
    enabled: true,
    environment: "STAGING",
    externalLocationId: "LOC-existing",
    providerLocationId: "PLOC-existing",
    channelLinkId: "CH-existing",
    apiToken: "existing-plaintext-token",
    hmacSecret: "existing-plaintext-hmac",
    apiTokenCipher: null,
    hmacSecretCipher: null,
    registerWebhookStatus: "registered",
    ordersWebhookStatus: "healthy",
    lastRegisterWebhookAt: null,
    lastOrderWebhookAt: null
  };

  const kdsFilter = {
    findUnique: vi.fn(async () => kdsFilterStored),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      ...kdsFilterStored,
      ...create,
      ...update
    }))
  };
  const kdsProviderConfig = {
    findUnique: vi.fn(async () => providerStored),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => ({
      ...providerStored,
      ...create,
      ...update
    }))
  };

  return {
    config: makeConfig(),
    hub: {
      currentSeq: vi.fn(async () => 0),
      publishSnapshotRequired: vi.fn(async () => undefined)
    },
    prisma: {
      kdsFilter,
      kdsProviderConfig,
      $transaction: vi.fn(async (callback: (tx: MockTx) => Promise<unknown>) =>
        callback({ kdsFilter, kdsProviderConfig })
      )
    }
  } as never;
}

function makeFloorWrite(overrides: Partial<KitchenBoardSettings> = {}): KitchenBoardSettings {
  return {
    filter: {
      allowedOrderTypes: [],
      blockedSources: [],
      paymentStates: [],
      createdAfterMinutes: null,
      searchText: "",
      includeCompleted: false,
      soundEnabled: false,
      screenPinEnabled: true
    },
    // Operator-config fields the Floor must NOT be able to overwrite:
    boardTimeZone: "America/Hacker",
    dailyResetEnabled: false,
    dailyResetTime: "00:00",
    urgencyWarningMinutes: 1,
    urgencyCriticalMinutes: 2,
    urgencyBlinkCritical: false,
    modifierDangerKeywords: ["pwned"],
    modifierAccentKeywords: ["pwned"],
    display: {
      weather: {
        enabled: false,
        zipCode: "00000",
        countryCode: "ZZ",
        unit: "celsius"
      }
    },
    providers: {
      deliverect: {
        enabled: true,
        environment: "production",
        externalLocationId: "LOC-malicious",
        locationId: "PLOC-malicious",
        channelLinkId: "CH-malicious",
        apiToken: "malicious-token",
        hmacSecret: "malicious-hmac",
        registerWebhookStatus: null,
        ordersWebhookStatus: null,
        lastRegisterWebhookAt: null,
        lastOrderWebhookAt: null
      }
    },
    ...overrides
  } as KitchenBoardSettings;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Phase 4.5.4 — saveBoardSettings role gating", () => {
  it("Floor write: persists per-screen filter prefs (soundEnabled, screenPinEnabled, etc.)", async () => {
    const services = createServices();
    const body = makeFloorWrite();

    await saveBoardSettings(services, "merchant-1", body, "floor");

    const upsertCall = services.prisma.kdsFilter.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(upsertCall.update.soundEnabled).toBe(false);
    expect(upsertCall.update.screenPinEnabled).toBe(true);
  });

  it("Floor write: strips operator-config + Deliverect, keeping existing on-disk values", async () => {
    const services = createServices();
    const body = makeFloorWrite();

    await saveBoardSettings(services, "merchant-1", body, "floor");

    // The Floor sent boardTimeZone="America/Hacker" but we should persist the
    // existing "America/Chicago" (the on-disk operator-config), not the
    // attacker-supplied value.
    const filterUpsertCall = services.prisma.kdsFilter.upsert.mock.calls[0]?.[0] as {
      update: { boardSettings: Record<string, unknown> };
    };
    const persistedBoardSettings = filterUpsertCall.update.boardSettings;
    expect(persistedBoardSettings.boardTimeZone).toBe("America/Chicago");
    expect(persistedBoardSettings.dailyResetEnabled).toBe(true);
    expect(persistedBoardSettings.urgencyWarningMinutes).toBe(10);

    // Weather config: Floor sent "celsius" + zipCode "00000" but the existing
    // operator-set US/00000/fahrenheit must be preserved.
    expect(persistedBoardSettings.display).toMatchObject({
      weather: {
        enabled: true,
        zipCode: "00000",
        countryCode: "US",
        unit: "fahrenheit"
      }
    });

    // Provider upsert: Floor writes never touch the kdsProviderConfig table.
    expect(services.prisma.kdsProviderConfig.upsert).not.toHaveBeenCalled();
  });

  it("Admin write: persists operator-config and Deliverect fields verbatim", async () => {
    const services = createServices();
    const body = makeFloorWrite({
      boardTimeZone: "America/Los_Angeles",
      urgencyWarningMinutes: 7
    });

    await saveBoardSettings(services, "merchant-1", body, "admin");

    const filterUpsertCall = services.prisma.kdsFilter.upsert.mock.calls[0]?.[0] as {
      update: { boardSettings: Record<string, unknown> };
    };
    expect(filterUpsertCall.update.boardSettings.boardTimeZone).toBe("America/Los_Angeles");
    expect(filterUpsertCall.update.boardSettings.urgencyWarningMinutes).toBe(7);

    // Admin tier DOES upsert the Deliverect provider row (legacy plaintext
    // path; the editor uses the dedicated /integrations/deliverect endpoint
    // which writes ciphers).
    expect(services.prisma.kdsProviderConfig.upsert).toHaveBeenCalledOnce();
    const providerUpsertCall = services.prisma.kdsProviderConfig.upsert.mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(providerUpsertCall.update.environment).toBe("PRODUCTION");
    expect(providerUpsertCall.update.externalLocationId).toBe("LOC-malicious");
    expect(providerUpsertCall.update.apiToken).toBe("malicious-token");
  });

  it("Floor PUT /api/kds/settings route invokes saveBoardSettings with role=floor", async () => {
    const services = createServices();
    const app = Fastify();
    await registerKdsRoutes(app as never, services);

    try {
      const body = makeFloorWrite();
      const response = await app.inject({
        method: "PUT",
        url: "/api/kds/settings?merchantId=merchant-1",
        payload: body
      });

      expect(response.statusCode).toBe(200);

      // The end-to-end assertion: the route hit Prisma but the persisted
      // operator-config matches the existing-on-disk values (proof that
      // role=floor was applied), and the kdsProviderConfig table was NOT
      // upserted (proof that Floor cannot write Deliverect at all).
      const filterUpsertCall = services.prisma.kdsFilter.upsert.mock.calls[0]?.[0] as {
        update: { boardSettings: Record<string, unknown> };
      };
      expect(filterUpsertCall.update.boardSettings.boardTimeZone).toBe("America/Chicago");
      expect(services.prisma.kdsProviderConfig.upsert).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
