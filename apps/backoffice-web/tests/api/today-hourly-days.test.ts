import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const hourlyMock = vi.fn();
const itemsMock = vi.fn();

vi.mock("@/lib/analytics-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/analytics-api")>("@/lib/analytics-api");
  return {
    ...actual,
    analyticsApi: {
      hourly: (...args: unknown[]) => hourlyMock(...args),
      items: (...args: unknown[]) => itemsMock(...args),
    },
  };
});

vi.mock("@/lib/location/scope", () => ({
  resolveAnalyticsMerchantId: () => Promise.resolve(undefined),
}));

vi.mock("@/lib/analytics-api/hourly-transform", () => ({
  transformToHourlyPulse: () => ({ today: [], baseline: [] }),
}));

vi.mock("@/lib/analytics-api/top-items-transform", () => ({
  transformToTopItems: (items: unknown, days: unknown) => ({ items, days }),
}));

beforeEach(() => {
  hourlyMock.mockReset();
  itemsMock.mockReset();
  hourlyMock.mockResolvedValue([]);
  itemsMock.mockResolvedValue({ items: [], days: 7 });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callHourly(url: string) {
  const { GET } = await import("@/app/api/today/hourly/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(url);
  return GET(request);
}

async function callTopItems(url: string) {
  const { GET } = await import("@/app/api/today/top-items/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(url);
  return GET(request);
}

describe("GET /api/today/hourly honors ?days=", () => {
  test("?days=200 clamps to max 90", async () => {
    await callHourly("http://localhost:3001/api/today/hourly?days=200");
    expect(hourlyMock).toHaveBeenCalledTimes(1);
    expect(hourlyMock).toHaveBeenCalledWith(90, { merchantId: undefined });
  });

  test("?days=foo (NaN) falls back to default 30", async () => {
    await callHourly("http://localhost:3001/api/today/hourly?days=foo");
    expect(hourlyMock).toHaveBeenCalledTimes(1);
    expect(hourlyMock).toHaveBeenCalledWith(30, { merchantId: undefined });
  });

  test("?days=5 (below min) clamps to min 7", async () => {
    await callHourly("http://localhost:3001/api/today/hourly?days=5");
    expect(hourlyMock).toHaveBeenCalledTimes(1);
    expect(hourlyMock).toHaveBeenCalledWith(7, { merchantId: undefined });
  });
});

describe("GET /api/today/top-items honors ?days=", () => {
  test("?days=200 clamps to max 90", async () => {
    await callTopItems("http://localhost:3001/api/today/top-items?days=200");
    expect(itemsMock).toHaveBeenCalledTimes(1);
    expect(itemsMock).toHaveBeenCalledWith(90, { merchantId: undefined });
  });

  test("?days=foo (NaN) falls back to default 7", async () => {
    await callTopItems("http://localhost:3001/api/today/top-items?days=foo");
    expect(itemsMock).toHaveBeenCalledTimes(1);
    expect(itemsMock).toHaveBeenCalledWith(7, { merchantId: undefined });
  });
});
