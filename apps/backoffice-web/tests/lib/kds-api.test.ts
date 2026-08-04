import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    ANALYTICS_ADMIN_TOKEN: "analytics-test-token",
    INTERNAL_ANALYTICS_API_URL: "http://analytics.test",
    KDS_INTERNAL_ADMIN_TOKEN: "kds-test-bearer-1234567890",
    INTERNAL_KDS_API_URL: "http://kds-api.test",
    BACKOFFICE_SESSION_COOKIE_NAME: "rop_backoffice_session"
  };
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("kdsApi when env not configured", () => {
  test("throws KdsApiNotConfiguredError naming both missing vars when both are absent", async () => {
    process.env.KDS_INTERNAL_ADMIN_TOKEN = "";
    process.env.INTERNAL_KDS_API_URL = "";
    // remove from object so optional schema treats as unset
    delete process.env.KDS_INTERNAL_ADMIN_TOKEN;
    delete process.env.INTERNAL_KDS_API_URL;

    const { kdsApi, KdsApiNotConfiguredError } = await import("@/lib/kds-api");
    await expect(kdsApi.listDevices(undefined)).rejects.toBeInstanceOf(KdsApiNotConfiguredError);
  });

  test("throws when only INTERNAL_KDS_API_URL is missing", async () => {
    delete process.env.INTERNAL_KDS_API_URL;

    const { kdsApi, KdsApiNotConfiguredError } = await import("@/lib/kds-api");
    const error = await kdsApi.listDevices(undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KdsApiNotConfiguredError);
    expect((error as InstanceType<typeof KdsApiNotConfiguredError>).missing).toEqual(["INTERNAL_KDS_API_URL"]);
  });
});

describe("kdsApi.listDevices", () => {
  test("calls /api/admin/kds/devices with bearer auth and no merchantId param when undefined", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ merchantId: "m-1", devices: [] }), { status: 200 })
    );

    const { kdsApi } = await import("@/lib/kds-api");
    const result = await kdsApi.listDevices(undefined);

    expect(result).toEqual({ merchantId: "m-1", devices: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/devices");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kds-test-bearer-1234567890");
    expect(init.method).toBe("GET");
  });

  test("appends merchantId query when provided and URL-encodes it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ merchantId: "merchant special", devices: [] }), { status: 200 })
    );

    const { kdsApi } = await import("@/lib/kds-api");
    await kdsApi.listDevices("merchant special");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/devices?merchantId=merchant%20special");
  });

  test("throws KdsApiError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 401 }));

    const { kdsApi, KdsApiError } = await import("@/lib/kds-api");
    await expect(kdsApi.listDevices(undefined)).rejects.toBeInstanceOf(KdsApiError);
  });
});

describe("kdsApi.createDevice", () => {
  test("POSTs to /api/admin/kds/devices with JSON body and bearer auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "device-new",
          merchantId: "m-1",
          label: "Kitchen Pad 2",
          role: "KDS",
          createdAt: "2026-05-16T12:00:00.000Z",
          token: "rev-tok-once"
        }),
        { status: 200 }
      )
    );

    const { kdsApi } = await import("@/lib/kds-api");
    const result = await kdsApi.createDevice({ merchantId: "m-1", label: "Kitchen Pad 2" });

    expect(result.token).toBe("rev-tok-once");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/devices");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ merchantId: "m-1", label: "Kitchen Pad 2" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kds-test-bearer-1234567890");
  });
});

describe("kdsApi.revokeDevice", () => {
  test("DELETEs /api/admin/kds/devices/:id with URL-encoded id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { kdsApi } = await import("@/lib/kds-api");
    await kdsApi.revokeDevice("device/with weird id");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/devices/device%2Fwith%20weird%20id");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("kdsApi clover integration methods", () => {
  test("getCloverIntegration GETs the right path with bearer auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          merchant: null,
          configuredMerchantId: null,
          status: { merchantId: null, authStatus: null, webhookStatus: null, lastWebhookAt: null, lastSyncAt: null, lastReconciledAt: null },
          dashboard: { siteUrl: "x", alternateLaunchPath: "x", oauthRedirectUri: "x", webhookUrl: "x", defaultOAuthResponse: "x", initialSubscriptions: [], initialPermissions: [] },
          readiness: { env: [] }
        }),
        { status: 200 }
      )
    );

    const { kdsApi } = await import("@/lib/kds-api");
    await kdsApi.getCloverIntegration();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/integrations/clover");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kds-test-bearer-1234567890");
  });
});

describe("kdsApi user-admin methods", () => {
  test("listUsers GETs /api/admin/kds/users", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [] }), { status: 200 })
    );

    const { kdsApi } = await import("@/lib/kds-api");
    await kdsApi.listUsers();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/users");
    expect(init.method).toBe("GET");
  });

  test("createUser POSTs JSON body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "u-1",
            username: "x",
            displayName: "X",
            role: "ADMIN",
            createdAt: "2026-05-16T12:00:00.000Z",
            updatedAt: "2026-05-16T12:00:00.000Z",
            passkeyCount: 0
          },
          setupUrl: "https://backoffice.test/set-password?token=abc",
          expiresInSeconds: 3600
        }),
        { status: 200 }
      )
    );

    const { kdsApi } = await import("@/lib/kds-api");
    const result = await kdsApi.createUser({ username: "x", displayName: "X" });

    expect(result.setupUrl).toBe("https://backoffice.test/set-password?token=abc");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/users");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ username: "x", displayName: "X" }));
  });

  test("updateUser uses PATCH method and URL-encodes id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: "u 1",
            username: "x",
            displayName: "Y",
            role: "ADMIN",
            createdAt: "2026-05-16T12:00:00.000Z",
            updatedAt: "2026-05-16T12:00:00.000Z",
            passkeyCount: 0
          }
        }),
        { status: 200 }
      )
    );

    const { kdsApi } = await import("@/lib/kds-api");
    await kdsApi.updateUser("u 1", { displayName: "Y" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/users/u%201");
    expect(init.method).toBe("PATCH");
  });

  test("revokeUserPasskey DELETEs nested path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { kdsApi } = await import("@/lib/kds-api");
    await kdsApi.revokeUserPasskey("u-1", "cred-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/users/u-1/passkeys/cred-1");
    expect(init.method).toBe("DELETE");
  });
});

describe("kdsApi.getBoardSettings / updateBoardSettings", () => {
  test("GET /api/admin/kds/board-settings without merchantId", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ merchantId: "m-1", settings: { urgencyWarningMinutes: 10 } }), {
        status: 200
      })
    );

    const { kdsApi } = await import("@/lib/kds-api");
    const result = await kdsApi.getBoardSettings(undefined);

    expect(result.merchantId).toBe("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/board-settings");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer kds-test-bearer-1234567890");
  });

  test("PUT /api/admin/kds/board-settings serializes body and uses PUT method", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ merchantId: "m-1", settings: {} }), { status: 200 })
    );

    const { kdsApi } = await import("@/lib/kds-api");
    const body = { urgencyWarningMinutes: 8 } as unknown as Parameters<typeof kdsApi.updateBoardSettings>[0];
    await kdsApi.updateBoardSettings(body, "m-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kds-api.test/api/admin/kds/board-settings?merchantId=m-1");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify(body));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
