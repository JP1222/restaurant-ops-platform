import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getAiSessionUserMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...args: unknown[]) => getAiSessionUserMock(...args),
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
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function callGet() {
  const { GET } = await import("@/app/api/ai/metrics/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost:3001/api/ai/metrics"));
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/ai/metrics", () => {
  test("401 when unauthenticated (no upstream call)", async () => {
    getAiSessionUserMock.mockResolvedValueOnce(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards the catalog from analytics (no merchant scoping)", async () => {
    getAiSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ metrics: [{ name: "net_sales_cents", unit: "cents" }] }),
    );

    const res = await callGet();
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { metrics: Array<{ name: string }> };
    expect(payload.metrics[0]?.name).toBe("net_sales_cents");

    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe("http://analytics.internal/admin/api/metrics");
    expect(calledUrl).not.toContain("merchant_id");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("maps an unreachable upstream to 502", async () => {
    getAiSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await callGet();
    expect(res.status).toBe(502);
  });
});
