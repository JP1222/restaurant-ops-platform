import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// POS bind = onboarding step 2 (ADR-0018): set CloverMerchant.locationId. The
// route must be ADMIN-gated, 404 an unknown store, and 409 when the db guard
// refuses (merchant missing or already bound) so it never re-points another
// store's POS.
const getSessionUserMock = vi.fn();
const getLocationByIdMock = vi.fn();
const bindMerchantToLocationMock = vi.fn();
const merchantIdForLocationMock = vi.fn();

vi.mock("@/lib/settings/session", () => ({
  getSettingsSessionUser: (...args: unknown[]) => getSessionUserMock(...args),
}));

vi.mock("@/lib/location/db", () => ({
  getLocationById: (...args: unknown[]) => getLocationByIdMock(...args),
  bindMerchantToLocation: (...args: unknown[]) => bindMerchantToLocationMock(...args),
  merchantIdForLocation: (...args: unknown[]) => merchantIdForLocationMock(...args),
}));

vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: () => {},
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

const ADMIN_USER = { id: "acct-1", username: "owner", displayName: "Owner", role: "ADMIN" };
const LOCATION = {
  id: "loc-2",
  name: "Downtown",
  slug: "downtown",
  timezone: "America/New_York",
  active: true,
};

beforeEach(() => {
  getSessionUserMock.mockReset();
  getLocationByIdMock.mockReset();
  bindMerchantToLocationMock.mockReset();
  merchantIdForLocationMock.mockReset();

  getSessionUserMock.mockResolvedValue(ADMIN_USER);
  getLocationByIdMock.mockResolvedValue(LOCATION);
  bindMerchantToLocationMock.mockResolvedValue(true);
  merchantIdForLocationMock.mockResolvedValue("MERCH2");

  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callBind(id: string, body: unknown) {
  const { POST } = await import("@/app/api/locations/[id]/bind/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest(`http://localhost:3001/api/locations/${id}/bind`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("POST /api/locations/[id]/bind", () => {
  test("binds an unlinked merchant and returns the store with its new merchantId", async () => {
    const res = await callBind("loc-2", { merchantId: "MERCH2" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { location: { id: string; merchantId: string | null } };
    expect(body.location.id).toBe("loc-2");
    expect(body.location.merchantId).toBe("MERCH2");
    expect(bindMerchantToLocationMock).toHaveBeenCalledWith("loc-2", "MERCH2");
  });

  test("409 when the merchant is missing or already bound (guard returned false)", async () => {
    bindMerchantToLocationMock.mockResolvedValueOnce(false);
    const res = await callBind("loc-2", { merchantId: "TAKEN" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("merchant_unavailable");
  });

  test("404 when the location does not exist (never attempts the bind)", async () => {
    getLocationByIdMock.mockResolvedValueOnce(null);
    const res = await callBind("ghost", { merchantId: "MERCH2" });
    expect(res.status).toBe(404);
    expect(bindMerchantToLocationMock).not.toHaveBeenCalled();
  });

  test("403 for a non-ADMIN session", async () => {
    getSessionUserMock.mockResolvedValueOnce({ ...ADMIN_USER, role: "VIEWER" });
    const res = await callBind("loc-2", { merchantId: "MERCH2" });
    expect(res.status).toBe(403);
    expect(bindMerchantToLocationMock).not.toHaveBeenCalled();
  });

  test("401 when unauthenticated", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const res = await callBind("loc-2", { merchantId: "MERCH2" });
    expect(res.status).toBe(401);
  });

  test("400 on an invalid body (missing merchantId)", async () => {
    const res = await callBind("loc-2", {});
    expect(res.status).toBe(400);
    expect(bindMerchantToLocationMock).not.toHaveBeenCalled();
  });
});
