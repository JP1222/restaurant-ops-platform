import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getSessionUserMock = vi.fn();
const saveRecipeMock = vi.fn();
const syncPlateCostsMock = vi.fn();
const handleInventoryApiErrorMock = vi.fn();

vi.mock("@/lib/auth/session-user", () => ({
  getSessionUser: (...args: unknown[]) => getSessionUserMock(...args),
}));
vi.mock("@/lib/inventory-api", () => ({
  inventoryApi: { saveRecipe: (...args: unknown[]) => saveRecipeMock(...args) },
  handleInventoryApiError: (...args: unknown[]) => handleInventoryApiErrorMock(...args),
}));
vi.mock("@/lib/analytics-api", () => ({
  analyticsApi: { syncPlateCosts: (...args: unknown[]) => syncPlateCostsMock(...args) },
}));

beforeEach(() => {
  getSessionUserMock.mockReset();
  saveRecipeMock.mockReset();
  syncPlateCostsMock.mockReset();
  handleInventoryApiErrorMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callPut(id: string, body: unknown) {
  const { PUT } = await import("@/app/api/inventory/recipes/[id]/route");
  const { NextRequest } = await import("next/server");
  return PUT(
    new NextRequest(`http://localhost:3001/api/inventory/recipes/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PUT /api/inventory/recipes/[id] (plate-cost sync)", () => {
  test("401 when unauthenticated, with no writes", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callPut("r1", { name: "Roll" });
    expect(res.status).toBe(401);
    expect(saveRecipeMock).not.toHaveBeenCalled();
    expect(syncPlateCostsMock).not.toHaveBeenCalled();
  });

  test("saves the recipe then triggers the plate-cost sync", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    saveRecipeMock.mockResolvedValueOnce({ id: "r1", name: "Roll" });
    syncPlateCostsMock.mockResolvedValueOnce({ received: 3, written: 3 });

    const res = await callPut("r1", { name: "Roll" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "r1", name: "Roll" });
    expect(saveRecipeMock).toHaveBeenCalledTimes(1);
    expect(syncPlateCostsMock).toHaveBeenCalledTimes(1);
  });

  test("best-effort sync: the recipe save still returns even if the sync fails", async () => {
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    saveRecipeMock.mockResolvedValueOnce({ id: "r1", name: "Roll" });
    syncPlateCostsMock.mockRejectedValueOnce(new Error("analytics down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await callPut("r1", { name: "Roll" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "r1", name: "Roll" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("an inventory write failure maps through handleInventoryApiError, no sync", async () => {
    const { NextResponse } = await import("next/server");
    getSessionUserMock.mockResolvedValueOnce({ id: "u1" });
    saveRecipeMock.mockRejectedValueOnce(new Error("inventory 503"));
    handleInventoryApiErrorMock.mockReturnValueOnce(
      NextResponse.json({ error: "inventory_unavailable" }, { status: 502 }),
    );

    const res = await callPut("r1", { name: "Roll" });
    expect(res.status).toBe(502);
    expect(syncPlateCostsMock).not.toHaveBeenCalled();
  });
});
