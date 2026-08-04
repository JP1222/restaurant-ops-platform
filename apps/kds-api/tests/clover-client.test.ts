import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MerchantAuthStatus, type CloverMerchant } from "@rop/db-kds";
import type { AppConfig } from "../src/config.js";
import {
  buildCloverFulfillmentEventPayload,
  CloverClient,
  CloverTimeoutError,
  cloverFulfillmentEventTypeForAction
} from "../src/lib/clover-client.js";
import { encryptSecretForStorage, resolveCloverMerchantSecrets } from "../src/lib/pos-token.js";

// Token columns are cipher-only (plaintext columns dropped in
// 20260618_drop_pos_token_plaintext). A fixed 64-char hex key lets the fixtures
// encrypt their tokens into the *Cipher columns the way real writes do.
beforeAll(() => {
  process.env.AI_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
});

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

// Convenience overrides: pass token values as PLAINTEXT and the fixture encrypts
// them into the *Cipher columns (the only place tokens live now). Anything else
// is a normal CloverMerchant override.
type MerchantSecretOverrides = {
  accessToken?: string | null;
  refreshToken?: string | null;
  recoveryToken?: string | null;
};

function makeMerchant(
  overrides: Partial<CloverMerchant> & MerchantSecretOverrides = {}
): CloverMerchant {
  const { accessToken, refreshToken, recoveryToken, ...rest } = overrides;
  return {
    id: "merchant-1",
    name: null,
    locationId: null,
    providerStoreId: null,
    posAccountId: null,
    employeeId: null,
    accessTokenCipher: encryptSecretForStorage(accessToken === undefined ? "merchant-token" : accessToken),
    refreshTokenCipher: encryptSecretForStorage(refreshToken ?? null),
    tokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    recoveryTokenCipher: encryptSecretForStorage(recoveryToken ?? null),
    authStatus: MerchantAuthStatus.ACTIVE,
    region: "US",
    appInstalledAt: null,
    lastWebhookAt: null,
    lastSyncAt: null,
    lastReconciledAt: null,
    resetCutoffAt: null,
    webhookStatus: null,
    kdsPin: null,
    createdAt: new Date("2026-04-22T00:00:00.000Z"),
    updatedAt: new Date("2026-04-22T00:00:00.000Z"),
    ...rest
  } as CloverMerchant;
}

function createPrisma(initialMerchant: CloverMerchant | null = makeMerchant()) {
  let merchant = initialMerchant ? { ...initialMerchant } : null;

  const cloverMerchant = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      merchant && merchant.id === where.id ? { ...merchant } : null
    ),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      if (!merchant || merchant.id !== where.id) {
        throw new Error(`Unknown merchant ${where.id}`);
      }
      return { ...merchant };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CloverMerchant> }) => {
      if (!merchant || merchant.id !== where.id) {
        throw new Error(`Unknown merchant ${where.id}`);
      }

      merchant = {
        ...merchant,
        ...data,
        updatedAt: new Date("2026-04-22T01:00:00.000Z")
      };
      return { ...merchant };
    }),
    upsert: vi.fn(async ({
      where,
      update,
      create
    }: {
      where: { id: string };
      update: Partial<CloverMerchant>;
      create: Partial<CloverMerchant>;
    }) => {
      merchant = merchant && merchant.id === where.id
        ? {
            ...merchant,
            ...update,
            updatedAt: new Date("2026-04-22T01:00:00.000Z")
          }
        : makeMerchant({
            id: where.id,
            ...create,
            updatedAt: new Date("2026-04-22T01:00:00.000Z")
          });

      return { ...merchant };
    })
  };

  return {
    prisma: {
      cloverMerchant
    } as never,
    cloverMerchant,
    getMerchant: () => (merchant ? { ...merchant } : null)
  };
}

function mockJsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("clover-client", () => {
  it("maps KDS actions into explicit Clover fulfillment event types", () => {
    expect(cloverFulfillmentEventTypeForAction("start")).toBe("KDS_IN_PROGRESS");
    expect(cloverFulfillmentEventTypeForAction("ready")).toBe("KDS_READY");
    expect(cloverFulfillmentEventTypeForAction("complete")).toBe("KDS_COMPLETED");
    expect(cloverFulfillmentEventTypeForAction("recall")).toBe("KDS_RECALLED");
    expect(cloverFulfillmentEventTypeForAction("acknowledge")).toBeNull();
  });

  it("builds an order-level fulfillment payload using the bare Clover order id (not the namespaced cloverOrderId)", () => {
    expect(
      buildCloverFulfillmentEventPayload(
        {
          merchantId: "merchant-1",
          // realistic prod value: the internal namespaced id. Must NOT leak into Clover.
          cloverOrderId: "clover:merchant-1:order-1",
          sourceOrderId: "order-1"
        },
        "complete",
        new Date("2026-04-21T03:45:00.000Z")
      )
    ).toEqual({
      orderFulfillmentEvent: {
        orderId: "order-1",
        clientCreatedTime: 1776743100000,
        type: "KDS_COMPLETED"
      }
    });
  });

  it("posts the fulfillment event back to Clover orders api", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { ok: true })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma();
    const client = new CloverClient(prisma, makeConfig());
    const payload = await client.pushTicketFulfillmentEvent(
      {
        merchantId: "merchant-1",
        // internal namespaced id — the URL + payload must use the bare sourceOrderId instead,
        // else Clover 401s on `/orders/clover:merchant-1:order-1` (the prod push-fulfillment bug).
        cloverOrderId: "clover:merchant-1:order-1",
        sourceOrderId: "order-1"
      },
      "ready",
      new Date("2026-04-21T04:00:00.000Z")
    );

    expect(payload).toEqual({
      orderFulfillmentEvent: {
        orderId: "order-1",
        clientCreatedTime: 1776744000000,
        type: "KDS_READY"
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clover.com/v3/merchants/merchant-1/orders/order-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
        headers: expect.objectContaining({
          accept: "application/json",
          authorization: "Bearer merchant-token",
          "content-type": "application/json",
          "user-agent": "restaurant-ops-platform-KDS/1.0"
        })
      })
    );
  });

  it("uses env token mode when no database merchant is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: "order-1" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        nodeEnv: "development",
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const order = await client.fetchOrder("merchant-1", "order-1");

    expect(order).toEqual({ id: "order-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clover.com/v3/merchants/merchant-1/orders/order-1?expand=lineItems.modifications,orderType,customers.phoneNumbers,payments",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer env-token"
        })
      })
    );
  });

  it("keeps env token mode available in production when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { id: "order-1" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        nodeEnv: "production",
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const order = await client.fetchOrder("merchant-1", "order-1");

    expect(order).toEqual({ id: "order-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clover.com/v3/merchants/merchant-1/orders/order-1?expand=lineItems.modifications,orderType,customers.phoneNumbers,payments",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer env-token"
        })
      })
    );
  });

  it("parses Clover v2 token expirations during OAuth exchange", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        access_token_expiration: 1776843600,
        refresh_token_expiration: 1779445600
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { prisma, getMerchant, cloverMerchant } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverAppId: "app-id",
        cloverAppSecret: "app-secret"
      })
    );

    await client.exchangeAuthorizationCode("auth-code", "merchant-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.clover.com/oauth/v2/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          accept: "application/json"
        }),
        body: JSON.stringify({
          client_id: "app-id",
          client_secret: "app-secret",
          code: "auth-code",
          redirect_uri: "https://kds.example.com/api/clover/oauth/callback"
        })
      })
    );
    expect(cloverMerchant.upsert).toHaveBeenCalledTimes(1);
    expect(getMerchant()).toMatchObject({ authStatus: MerchantAuthStatus.ACTIVE });
    // Secrets are encrypted at rest in the *Cipher columns; decode round-trips.
    expect(resolveCloverMerchantSecrets(getMerchant()!)).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      recoveryToken: null
    });
    expect(getMerchant()?.tokenExpiresAt?.toISOString()).toBe(
      new Date(1776843600 * 1000).toISOString()
    );
    expect(getMerchant()?.refreshTokenExpiresAt?.toISOString()).toBe(
      new Date(1779445600 * 1000).toISOString()
    );
  });

  it("proactively refreshes expiring access tokens before a Clover request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T08:59:00.000Z"));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          access_token: "fresh-access",
          refresh_token: "refresh-2",
          access_token_expiration: 1776847200,
          refresh_token_expiration: 1779449200
        })
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, { id: "order-1" })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { prisma, getMerchant } = createPrisma(
      makeMerchant({
        accessToken: "stale-access",
        refreshToken: "refresh-1",
        tokenExpiresAt: new Date("2026-04-22T09:00:00.000Z")
      })
    );
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverAppId: "app-id"
      })
    );

    await client.fetchOrder("merchant-1", "order-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.clover.com/oauth/v2/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "app-id",
          refresh_token: "refresh-1"
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.clover.com/v3/merchants/merchant-1/orders/order-1?expand=lineItems.modifications,orderType,customers.phoneNumbers,payments",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer fresh-access"
        })
      })
    );
    expect(getMerchant()).toMatchObject({ authStatus: MerchantAuthStatus.ACTIVE });
    expect(resolveCloverMerchantSecrets(getMerchant()!)).toEqual({
      accessToken: "fresh-access",
      refreshToken: "refresh-2",
      recoveryToken: "refresh-1"
    });
  });

  it("retries a 401 request after refreshing the Clover token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(401, {}))
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          access_token: "fresh-after-401",
          refresh_token: "refresh-2",
          access_token_expiration: 1776847200,
          refresh_token_expiration: 1779449200
        })
      )
      .mockResolvedValueOnce(mockJsonResponse(200, { id: "order-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const { prisma, getMerchant } = createPrisma(
      makeMerchant({
        accessToken: "expired-access",
        refreshToken: "refresh-1",
        tokenExpiresAt: new Date("2099-04-22T09:30:00.000Z")
      })
    );
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverAppId: "app-id"
      })
    );

    await client.fetchOrder("merchant-1", "order-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.clover.com/v3/merchants/merchant-1/orders/order-1?expand=lineItems.modifications,orderType,customers.phoneNumbers,payments",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer fresh-after-401"
        })
      })
    );
    expect(getMerchant()).toMatchObject({ authStatus: MerchantAuthStatus.ACTIVE });
    expect(resolveCloverMerchantSecrets(getMerchant()!)).toEqual({
      accessToken: "fresh-after-401",
      refreshToken: "refresh-2",
      recoveryToken: "refresh-1"
    });
  });

  it("uses Clover recovery flow when refresh indicates a recovery token is available", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(401, {}))
      .mockResolvedValueOnce(
        mockJsonResponse(401, {}, {
          "x-clover-recovery-available": "true"
        })
      )
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          access_token: "recovered-access",
          refresh_token: "refresh-3",
          access_token_expiration: 1776847200,
          refresh_token_expiration: 1779449200
        })
      )
      .mockResolvedValueOnce(mockJsonResponse(200, { id: "order-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const { prisma, getMerchant } = createPrisma(
      makeMerchant({
        accessToken: "expired-access",
        refreshToken: "refresh-2",
        recoveryToken: "refresh-1",
        tokenExpiresAt: new Date("2099-04-22T09:30:00.000Z")
      })
    );
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverAppId: "app-id",
        cloverAppSecret: "app-secret"
      })
    );

    await client.fetchOrder("merchant-1", "order-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.clover.com/oauth/v2/recovery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          client_id: "app-id",
          client_secret: "app-secret",
          recovery_token: "refresh-1"
        })
      })
    );
    expect(getMerchant()).toMatchObject({ authStatus: MerchantAuthStatus.ACTIVE });
    expect(resolveCloverMerchantSecrets(getMerchant()!)).toEqual({
      accessToken: "recovered-access",
      refreshToken: "refresh-3",
      recoveryToken: "refresh-1"
    });
  });

  it("expands lineItems.modifications when listing modified orders", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse(200, { elements: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const result = await client.fetchModifiedOrders("merchant-1", new Date("2026-04-22T00:00:00.000Z"));

    expect(result).toEqual({ elements: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("expand=lineItems.modifications,orderType");
    expect(calledUrl).toContain("filter=modifiedTime%3E%3D");
    expect(calledUrl).toContain("limit=100");
    expect(calledUrl).toContain("offset=0");
  });

  it("paginates modified orders beyond a single 100-order page (GH #166)", async () => {
    // 250 modified orders in the window => 3 Clover pages (100, 100, 50). The
    // old single limit=100 fetch silently dropped orders 101-250; pagination
    // must walk offsets until a short page signals the end.
    const page = (start: number, count: number) => ({
      elements: Array.from({ length: count }, (_, i) => ({ id: `order-${start + i}` }))
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(200, page(0, 100)))
      .mockResolvedValueOnce(mockJsonResponse(200, page(100, 100)))
      .mockResolvedValueOnce(mockJsonResponse(200, page(200, 50)));
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const result = await client.fetchModifiedOrders("merchant-1", new Date("2026-04-22T00:00:00.000Z"));

    // No tail lost: all 250 orders returned in the same { elements } shape.
    expect(result.elements).toHaveLength(250);
    expect(result.elements[0]).toEqual({ id: "order-0" });
    expect(result.elements[249]).toEqual({ id: "order-249" });

    // Exactly three fetches — the short final page stops the loop (no 4th,
    // empty request).
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const offsets = fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "100", "200"]);
  });

  it("stops paginating modified orders after a single full-but-final page (GH #166)", async () => {
    // An exactly-full first page followed by an empty page: the loop issues the
    // second fetch (it cannot know the first was the last) then stops.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          elements: Array.from({ length: 100 }, (_, i) => ({ id: `order-${i}` }))
        })
      )
      .mockResolvedValueOnce(mockJsonResponse(200, { elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const result = await client.fetchModifiedOrders("merchant-1", new Date("2026-04-22T00:00:00.000Z"));

    expect(result.elements).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks the merchant auth status as error when refresh and recovery both fail", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse(401, {}))
      .mockResolvedValueOnce(mockJsonResponse(401, {}));
    vi.stubGlobal("fetch", fetchMock);

    const { prisma, getMerchant } = createPrisma(
      makeMerchant({
        accessToken: "expired-access",
        refreshToken: "refresh-2",
        recoveryToken: "refresh-1",
        tokenExpiresAt: new Date("2099-04-22T09:30:00.000Z")
      })
    );
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverAppId: "app-id",
        cloverAppSecret: "app-secret"
      })
    );

    await expect(client.fetchOrder("merchant-1", "order-1")).rejects.toThrow(
      "Clover request failed with 401 for /v3/merchants/merchant-1/orders/order-1?expand=lineItems.modifications,orderType,customers.phoneNumbers,payments."
    );
    expect(getMerchant()?.authStatus).toBe(MerchantAuthStatus.ERROR);
  });

  it("wraps an aborted fetch in CloverTimeoutError and attaches an AbortSignal", async () => {
    // Simulate Node's `fetch()` behavior when AbortSignal.timeout() fires: it
    // rejects with a DOMException whose name is "TimeoutError" (or
    // "AbortError" on older shapes). cloverFetch must catch BOTH and rethrow
    // a typed CloverTimeoutError so on-call can tell a hung request from a
    // 5xx, and so the timeout counter — not the generic-network branch —
    // increments.
    let observedSignal: AbortSignal | null = null;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? null;
      const abortError = Object.assign(new Error("The operation was aborted"), {
        name: "TimeoutError"
      });
      return Promise.reject(abortError);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const error = await client.fetchOrder("merchant-1", "order-1").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CloverTimeoutError);
    expect((error as CloverTimeoutError).stage).toBe("request");
    expect((error as CloverTimeoutError).timeoutMs).toBe(10_000);
    expect((error as CloverTimeoutError).message).toContain("timed out after 10000ms");

    // The signal must be attached to every Clover fetch — that's the bug GH
    // #122 fixes. Without it, a hung TCP socket would block the worker
    // forever and starve BullMQ.
    expect(observedSignal).not.toBeNull();
    expect(observedSignal).toBeInstanceOf(AbortSignal);

    // fetchWithRefresh's 5xx/429 retry loop only fires on a real response.
    // A timeout rejects before any status is observed, so exactly one fetch
    // invocation — confirming retries do NOT stack additional timeouts on
    // top of an already-hung request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-AbortError fetch failures unchanged (not as CloverTimeoutError)", async () => {
    // Generic network errors (ECONNRESET, DNS, TLS) must NOT be relabelled
    // as timeouts — otherwise the new timeout metric would double-count
    // ordinary connectivity issues and obscure the actual symptom.
    const networkError = Object.assign(new Error("fetch failed"), { name: "TypeError" });
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    vi.stubGlobal("fetch", fetchMock);

    const { prisma } = createPrisma(null);
    const client = new CloverClient(
      prisma,
      makeConfig({
        cloverMerchantId: "merchant-1",
        cloverToken: "env-token"
      })
    );

    const error = await client.fetchOrder("merchant-1", "order-1").catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(CloverTimeoutError);
    expect((error as Error).message).toBe("fetch failed");
  });
});
