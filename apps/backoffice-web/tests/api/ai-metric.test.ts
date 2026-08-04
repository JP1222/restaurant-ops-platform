import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getAiSessionUserMock = vi.fn();
const resolveMerchantMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...args: unknown[]) => getAiSessionUserMock(...args),
}));
vi.mock("@/lib/location/scope", () => ({
  resolveAnalyticsMerchantId: (...args: unknown[]) => resolveMerchantMock(...args),
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    INTERNAL_ANALYTICS_API_URL: "http://analytics.internal",
    ANALYTICS_ADMIN_TOKEN: "test-token",
  }),
}));
vi.mock("@/lib/ai/log", () => ({
  errorMessage: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
  logErrorEvent: () => undefined,
}));

beforeEach(() => {
  getAiSessionUserMock.mockReset();
  resolveMerchantMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function callPost(body: unknown) {
  const { POST } = await import("@/app/api/ai/metric/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost:3001/api/ai/metric", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/ai/metric", () => {
  test("401 when unauthenticated (no upstream call)", async () => {
    getAiSessionUserMock.mockResolvedValueOnce(null);
    const res = await callPost({ name: "net_sales_cents", window: { mode: "days", days: 30 } });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("400 on a missing metric name (no upstream call)", async () => {
    getAiSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    const res = await callPost({ window: { mode: "days", days: 30 } });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards to /admin/api/metric scoped to the active store", async () => {
    getAiSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    resolveMerchantMock.mockResolvedValueOnce("MERCHANT-2");
    fetchMock.mockResolvedValueOnce(jsonResponse({ rows: [{ value: 123 }], unit: "cents" }));

    const res = await callPost({ name: "net_sales_cents", window: { mode: "days", days: 7 } });
    expect(res.status).toBe(200);

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("http://analytics.internal/admin/api/metric");
    expect(calledUrl).toContain("merchant_id=MERCHANT-2");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("omits merchant_id on the single-store path (resolver returns undefined)", async () => {
    getAiSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    resolveMerchantMock.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse({ rows: [], unit: "cents" }));

    await callPost({ name: "order_count", window: { mode: "days", days: 7 } });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain("merchant_id");
  });

  test("maps an upstream 400 (rejected metric) to 400", async () => {
    getAiSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    resolveMerchantMock.mockResolvedValueOnce(undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "metric_rejected" }, 400));

    const res = await callPost({ name: "bogus_metric", window: { mode: "days", days: 7 } });
    expect(res.status).toBe(400);
  });
});
