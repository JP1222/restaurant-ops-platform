import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getSessionUserMock = vi.fn();
const saveLaborCostMock = vi.fn();
const syncLaborCostsMock = vi.fn();
const handleInventoryApiErrorMock = vi.fn();

vi.mock("@/lib/auth/session-user", () => ({
  getSessionUser: (...args: unknown[]) => getSessionUserMock(...args)
}));
vi.mock("@/lib/inventory-api", () => ({
  inventoryApi: { saveLaborCost: (...args: unknown[]) => saveLaborCostMock(...args) },
  handleInventoryApiError: (...args: unknown[]) => handleInventoryApiErrorMock(...args)
}));
vi.mock("@/lib/analytics-api", () => ({
  analyticsApi: { syncLaborCosts: (...args: unknown[]) => syncLaborCostsMock(...args) }
}));

beforeEach(() => {
  getSessionUserMock.mockReset();
  saveLaborCostMock.mockReset();
  syncLaborCostsMock.mockReset();
  handleInventoryApiErrorMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALID = {
  daily_labor_cost_cents: 46666.67,
  currency: "USD",
  effective_from: "2026-06-01",
  note: "$2,800/wk / 6 days"
};

async function callPost(body: unknown) {
  const { POST } = await import("@/app/api/costs/labor/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost:3001/api/costs/labor", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  );
}

describe("POST /api/costs/labor", () => {
  test("401 when unauthenticated, with no writes", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callPost(VALID);
    expect(res.status).toBe(401);
    expect(saveLaborCostMock).not.toHaveBeenCalled();
    expect(syncLaborCostsMock).not.toHaveBeenCalled();
  });

  test("400 on a malformed effective_from, with no writes", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    const res = await callPost({ ...VALID, effective_from: "06/01/2026" });
    expect(res.status).toBe(400);
    expect(saveLaborCostMock).not.toHaveBeenCalled();
  });

  test("persists to inventory-api then triggers the analytics sync", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    saveLaborCostMock.mockResolvedValueOnce({});
    syncLaborCostsMock.mockResolvedValueOnce({ received: 1, written: 1, refreshed: true });

    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      sync: { received: 1, written: 1, refreshed: true }
    });
    expect(saveLaborCostMock).toHaveBeenCalledTimes(1);
    expect(syncLaborCostsMock).toHaveBeenCalledTimes(1);
  });

  test("best-effort sync: the save still succeeds if the analytics pull fails", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    saveLaborCostMock.mockResolvedValueOnce({});
    syncLaborCostsMock.mockRejectedValueOnce(new Error("analytics down"));

    const res = await callPost(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sync: null });
  });

  test("an inventory write failure maps through handleInventoryApiError, no sync", async () => {
    const { NextResponse } = await import("next/server");
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    saveLaborCostMock.mockRejectedValueOnce(new Error("inventory 503"));
    handleInventoryApiErrorMock.mockReturnValueOnce(
      NextResponse.json({ error: "inventory_unavailable" }, { status: 502 })
    );

    const res = await callPost(VALID);
    expect(res.status).toBe(502);
    expect(syncLaborCostsMock).not.toHaveBeenCalled();
  });
});
