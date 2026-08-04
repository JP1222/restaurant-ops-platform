import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    ANALYTICS_ADMIN_TOKEN: "test-token",
    INTERNAL_ANALYTICS_API_URL: "http://analytics.test",
    KDS_INTERNAL_ADMIN_TOKEN: "kds-test-bearer-1234567890",
    INTERNAL_KDS_API_URL: "http://kds-api.test",
    BACKOFFICE_SESSION_COOKIE_NAME: "rop_backoffice_session",
  };
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("analyticsApi.healthz", () => {
  test("calls /healthz without auth header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { analyticsApi } = await import("@/lib/analytics-api");
    const result = await analyticsApi.healthz();

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/healthz");
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});

describe("analyticsApi.sales", () => {
  test("calls /admin/api/sales with auth header and days param", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ days: 7, daily: [], totals: {} }), { status: 200 }),
      );

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.sales({ days: 7 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/sales?days=7");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("rejects out-of-range days", async () => {
    const { analyticsApi } = await import("@/lib/analytics-api");

    expect(() => analyticsApi.sales({ days: 0 })).toThrow(RangeError);
    expect(() => analyticsApi.sales({ days: 366 })).toThrow(RangeError);
    expect(() => analyticsApi.sales({ days: 1.5 })).toThrow(RangeError);
  });

  test("calls /admin/api/sales with auth header and date range params", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ from: "2026-04-01", to: "2026-04-30", daily: [], totals: {} }),
          { status: 200 },
        ),
      );

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.sales({ from: "2026-04-01", to: "2026-04-30" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/sales?from=2026-04-01&to=2026-04-30");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("rejects invalid date ranges", async () => {
    const { analyticsApi } = await import("@/lib/analytics-api");

    expect(() => analyticsApi.sales({ from: "2026-4-1", to: "2026-04-30" })).toThrow(RangeError);
    expect(() => analyticsApi.sales({ from: "2026-05-01", to: "2026-04-30" })).toThrow(RangeError);
  });

  test("throws AnalyticsApiError on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream error", { status: 502 }),
    );

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await expect(analyticsApi.sales({ days: 7 })).rejects.toBeInstanceOf(AnalyticsApiError);
  });
});

describe("analyticsApi.hourly", () => {
  test("calls /admin/api/hourly with auth header and days param", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.hourly(30);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/hourly?days=30");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("rejects out-of-range hourly days", async () => {
    const { analyticsApi } = await import("@/lib/analytics-api");

    expect(() => analyticsApi.hourly(0)).toThrow(RangeError);
    expect(() => analyticsApi.hourly(91)).toThrow(RangeError);
    expect(() => analyticsApi.hourly(1.5)).toThrow(RangeError);
  });

  test("throws AnalyticsApiError on hourly non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream error", { status: 502 }),
    );

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await expect(analyticsApi.hourly(30)).rejects.toBeInstanceOf(AnalyticsApiError);
  });
});

describe("analyticsApi.items", () => {
  test("calls /admin/api/items with auth header and days param", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ days: 7, items: [] }), { status: 200 }));

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.items(7);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/items?days=7");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("rejects out-of-range item days", async () => {
    const { analyticsApi } = await import("@/lib/analytics-api");

    expect(() => analyticsApi.items(0)).toThrow(RangeError);
    expect(() => analyticsApi.items(91)).toThrow(RangeError);
    expect(() => analyticsApi.items(1.5)).toThrow(RangeError);
  });

  test("throws AnalyticsApiError on items non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream error", { status: 502 }),
    );

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await expect(analyticsApi.items(7)).rejects.toBeInstanceOf(AnalyticsApiError);
  });
});

describe("analyticsApi.itemHourly", () => {
  test("calls /admin/api/items/:fp/hourly with auth header and days param", async () => {
    const fingerprint = "fp-burger-deluxe";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ item_fingerprint: fingerprint, days: 30, rows: [] }),
          { status: 200 },
        ),
      );

    const { analyticsApi } = await import("@/lib/analytics-api");
    const result = await analyticsApi.itemHourly(fingerprint, 30);

    expect(result).toEqual({ item_fingerprint: fingerprint, days: 30, rows: [] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://analytics.test/admin/api/items/${encodeURIComponent(fingerprint)}/hourly?days=30`,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("rejects out-of-range itemHourly days", async () => {
    const { analyticsApi } = await import("@/lib/analytics-api");

    expect(() => analyticsApi.itemHourly("fp", 0)).toThrow(RangeError);
    expect(() => analyticsApi.itemHourly("fp", 91)).toThrow(RangeError);
    expect(() => analyticsApi.itemHourly("fp", 1.5)).toThrow(RangeError);
  });
});

describe("analyticsApi.itemModifiers", () => {
  test("calls /admin/api/items/:fp/modifiers with auth header and days param", async () => {
    const fingerprint = "fp-burger-deluxe";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            item_fingerprint: fingerprint,
            days: 30,
            line_count: 0,
            modifiers: [],
          }),
          { status: 200 },
        ),
      );

    const { analyticsApi } = await import("@/lib/analytics-api");
    const result = await analyticsApi.itemModifiers(fingerprint, 30);

    expect(result).toEqual({
      item_fingerprint: fingerprint,
      days: 30,
      line_count: 0,
      modifiers: [],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `http://analytics.test/admin/api/items/${encodeURIComponent(fingerprint)}/modifiers?days=30`,
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("rejects out-of-range itemModifiers days", async () => {
    const { analyticsApi } = await import("@/lib/analytics-api");

    expect(() => analyticsApi.itemModifiers("fp", 0)).toThrow(RangeError);
    expect(() => analyticsApi.itemModifiers("fp", 91)).toThrow(RangeError);
    expect(() => analyticsApi.itemModifiers("fp", 1.5)).toThrow(RangeError);
  });
});

describe("analyticsApi operations methods", () => {
  test("calls /admin/api/overview with auth header and throws on non-2xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            merchantId: "merchant1",
            health: null,
            heartbeats: [],
            jobCounts: [],
            dirtyWindows: [],
            historicalBackfill: {
              expectedWindows: 0,
              completedWindows: 0,
              failedWindows: 0,
              blockedWindows: 0,
              progressPct: 0,
              currentWindowStart: null,
              currentWindowEnd: null,
              currentWindowStatus: "completed",
              lastCompletedAt: null,
              lastError: null,
              nextHistoricalWindowAt: null,
              runningWindows: 0,
              maxConcurrentWindows: 2,
              windowsCompletedLast24h: 0,
              estimatedCompletionAt: null,
              rowsWrittenTotal: 0,
              warningWindows: 0,
              parkedWindows: 0,
              needsManualIntervention: false,
              attentionWindows: [],
            },
            dataRanges: [],
            dqFailures: [],
            reconBreaks: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }));

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.overview();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/overview");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    await expect(analyticsApi.overview()).rejects.toBeInstanceOf(AnalyticsApiError);
  });

  test("calls /admin/api/jobs with auth header and throws on non-2xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ recentJobs: [], failedJobs: [], dataQualityChecks: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }));

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.jobs();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/jobs");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    await expect(analyticsApi.jobs()).rejects.toBeInstanceOf(AnalyticsApiError);
  });

  test("calls /admin/webhook-verifications with auth header and throws on non-2xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ verifications: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }));

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.webhookVerifications();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/webhook-verifications");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    await expect(analyticsApi.webhookVerifications()).rejects.toBeInstanceOf(AnalyticsApiError);
  });

  test("calls /admin/api/database with auth header and throws on non-2xx", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tables: [],
            totals: { table_count: 0, bytes_total: 0, size_pretty: "0 bytes" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }));

    const { AnalyticsApiError, analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.database();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/database");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    await expect(analyticsApi.database()).rejects.toBeInstanceOf(AnalyticsApiError);
  });
});

describe("analyticsApi merchant scoping", () => {
  test("appends merchant_id after an existing query string", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ days: 7, daily: [], totals: {} }), { status: 200 }),
      );

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.sales({ days: 7 }, { merchantId: "MERCHANT_2" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/sales?days=7&merchant_id=MERCHANT_2");
  });

  test("omits merchant_id when none is provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.hourly(30);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/hourly?days=30");
  });

  test("scopes a path that has no existing query string", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const { analyticsApi } = await import("@/lib/analytics-api");
    await analyticsApi.overview({ merchantId: "M3" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://analytics.test/admin/api/overview?merchant_id=M3");
  });
});
