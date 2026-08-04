import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const forecastMock = vi.fn();
const runForecastMock = vi.fn();
const resolveMerchantMock = vi.fn();
const getSessionUserMock = vi.fn();

vi.mock("@/lib/analytics-api", () => ({
  analyticsApi: {
    forecast: (...args: unknown[]) => forecastMock(...args),
    runForecast: (...args: unknown[]) => runForecastMock(...args),
  },
  handleAnalyticsApiError: () =>
    new Response(JSON.stringify({ error: "upstream" }), { status: 502 }),
}));
vi.mock("@/lib/location/scope", () => ({
  resolveAnalyticsMerchantId: (...args: unknown[]) => resolveMerchantMock(...args),
}));
vi.mock("@/lib/auth/session-user", () => ({
  getSessionUser: (...args: unknown[]) => getSessionUserMock(...args),
}));

beforeEach(() => {
  forecastMock.mockReset();
  runForecastMock.mockReset();
  resolveMerchantMock.mockReset();
  getSessionUserMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function load() {
  const mod = await import("@/app/api/forecast/route");
  const { NextRequest } = await import("next/server");
  return { mod, NextRequest };
}

describe("/api/forecast", () => {
  test("GET forwards to analytics scoped to the resolved merchant", async () => {
    resolveMerchantMock.mockResolvedValueOnce("M2");
    forecastMock.mockResolvedValueOnce({ points: [], backtest: [], generated_at: null });

    const { mod } = await load();
    const res = await mod.GET();
    expect(res.status).toBe(200);
    expect(forecastMock).toHaveBeenCalledWith({ merchantId: "M2" });
  });

  test("POST 401 when unauthenticated, with no run", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const { mod, NextRequest } = await load();
    const res = await mod.POST(
      new NextRequest("http://localhost:3001/api/forecast", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(runForecastMock).not.toHaveBeenCalled();
  });

  test("POST recomputes the forecast for an authenticated operator", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    resolveMerchantMock.mockResolvedValueOnce(undefined);
    runForecastMock.mockResolvedValueOnce({
      merchantId: "default",
      horizonDays: 14,
      written: 28,
      backtest: [],
    });

    const { mod, NextRequest } = await load();
    const res = await mod.POST(
      new NextRequest("http://localhost:3001/api/forecast", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(runForecastMock).toHaveBeenCalledWith({ merchantId: undefined });
  });
});
