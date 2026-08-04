import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const trendsBreakdownMock = vi.fn();
const resolveMerchantMock = vi.fn();

vi.mock("@/lib/analytics-api", () => ({
  analyticsApi: { trendsBreakdown: (...args: unknown[]) => trendsBreakdownMock(...args) },
  handleAnalyticsApiError: () =>
    new Response(JSON.stringify({ error: "upstream" }), { status: 502 }),
}));
vi.mock("@/lib/location/scope", () => ({
  resolveAnalyticsMerchantId: (...args: unknown[]) => resolveMerchantMock(...args),
}));

beforeEach(() => {
  trendsBreakdownMock.mockReset();
  resolveMerchantMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet(qs: string) {
  const { GET } = await import("@/app/api/trends/breakdown/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost:3001/api/trends/breakdown?${qs}`));
}

describe("GET /api/trends/breakdown", () => {
  test("400 on a missing/invalid date, with no upstream call", async () => {
    const res = await callGet("from=2026-06-01");
    expect(res.status).toBe(400);
    expect(trendsBreakdownMock).not.toHaveBeenCalled();
  });

  test("400 when from > to", async () => {
    const res = await callGet("from=2026-06-10&to=2026-06-01");
    expect(res.status).toBe(400);
    expect(trendsBreakdownMock).not.toHaveBeenCalled();
  });

  test("forwards to analytics scoped to the resolved merchant", async () => {
    resolveMerchantMock.mockResolvedValueOnce("M2");
    trendsBreakdownMock.mockResolvedValueOnce({
      from: "2026-06-01",
      to: "2026-06-07",
      order_type: [],
      tender: [],
      daypart: [],
    });

    const res = await callGet("from=2026-06-01&to=2026-06-07");
    expect(res.status).toBe(200);
    expect(trendsBreakdownMock).toHaveBeenCalledWith(
      { from: "2026-06-01", to: "2026-06-07" },
      { merchantId: "M2" },
    );
  });

  test("maps an upstream failure to 502", async () => {
    resolveMerchantMock.mockResolvedValueOnce(undefined);
    trendsBreakdownMock.mockRejectedValueOnce(new Error("analytics down"));
    const res = await callGet("from=2026-06-01&to=2026-06-07");
    expect(res.status).toBe(502);
  });
});
