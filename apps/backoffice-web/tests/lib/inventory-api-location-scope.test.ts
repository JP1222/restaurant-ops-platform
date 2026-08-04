import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted cookie state the next/headers mock reads at call time, mirroring
// location-scope.test.ts. The inventory BFF client must scope every inventory-api
// call to the StoreSwitcher's active store (yr_active_location cookie) so a
// manager viewing store #2 never reads/writes store #1's (default-location) stock.
const cookieHolder = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (cookieHolder.value === null ? undefined : { value: cookieHolder.value }),
  }),
}));

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    INTERNAL_INVENTORY_API_URL: "http://inventory.test",
    INVENTORY_INTERNAL_TOKEN: undefined,
  }),
}));

import { inventoryApi } from "@/lib/inventory-api";

const fetchMock = vi.fn();

beforeEach(() => {
  cookieHolder.value = null;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function calledUrl(): URL {
  return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

describe("inventory BFF client — active-location scoping", () => {
  test("a selected store injects ?location=<locationId> on a read", async () => {
    cookieHolder.value = "loc-2";
    await inventoryApi.getDataset();
    expect(calledUrl().searchParams.get("location")).toBe("loc-2");
  });

  test("a selected store injects ?location= on a write (POST)", async () => {
    cookieHolder.value = "loc-2";
    await inventoryApi.toggle86("item-1");
    expect(calledUrl().searchParams.get("location")).toBe("loc-2");
  });

  test("no cookie (single-store) sends no location — upstream default scope, zero regression", async () => {
    cookieHolder.value = null;
    await inventoryApi.getDataset();
    expect(calledUrl().searchParams.has("location")).toBe(false);
  });

  test("'All stores' sends no location (no consolidation; upstream default)", async () => {
    cookieHolder.value = "all";
    await inventoryApi.getDataset();
    expect(calledUrl().searchParams.has("location")).toBe(false);
  });

  test("preserves an existing query string and adds location", async () => {
    cookieHolder.value = "loc-2";
    await inventoryApi.getDataset({ includeArchived: true });
    const url = calledUrl();
    expect(url.searchParams.get("include")).toBe("archived");
    expect(url.searchParams.get("location")).toBe("loc-2");
  });
});
