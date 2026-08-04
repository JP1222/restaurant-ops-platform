import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted state the next/headers + db mocks read at call time.
const cookieHolder = vi.hoisted(() => ({ value: null as string | null }));
const merchantIdForLocationMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (cookieHolder.value === null ? undefined : { value: cookieHolder.value }),
  }),
}));

vi.mock("@/lib/location/db", () => ({
  merchantIdForLocation: merchantIdForLocationMock,
}));

import { decideAnalyticsScope, resolveAnalyticsMerchantId } from "@/lib/location/scope";

beforeEach(() => {
  cookieHolder.value = null;
  merchantIdForLocationMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("decideAnalyticsScope", () => {
  test("no selection resolves to undefined (analytics default store)", () => {
    expect(decideAnalyticsScope(null, null)).toBeUndefined();
    expect(decideAnalyticsScope(null, "M1")).toBeUndefined();
  });

  test("'All stores' resolves to undefined (analytics default store)", () => {
    expect(decideAnalyticsScope("all", "M1")).toBeUndefined();
  });

  test("a bound store resolves to its merchant id", () => {
    expect(decideAnalyticsScope("loc-1", "M-loc-1")).toBe("M-loc-1");
  });

  test("an unbound store resolves to its own locationId (matches no mart rows)", () => {
    // Safety: never silently fall back to the default store's numbers under a
    // different store's name. The locationId matches no mart rows -> "no data".
    expect(decideAnalyticsScope("loc-1", null)).toBe("loc-1");
  });
});

describe("resolveAnalyticsMerchantId", () => {
  test("no cookie resolves to undefined without a DB lookup", async () => {
    expect(await resolveAnalyticsMerchantId()).toBeUndefined();
    expect(merchantIdForLocationMock).not.toHaveBeenCalled();
  });

  test("'All stores' resolves to undefined without a DB lookup", async () => {
    cookieHolder.value = "all";
    expect(await resolveAnalyticsMerchantId()).toBeUndefined();
    expect(merchantIdForLocationMock).not.toHaveBeenCalled();
  });

  test("a specific store maps to its merchant id", async () => {
    cookieHolder.value = "loc-1";
    merchantIdForLocationMock.mockResolvedValue("M-loc-1");
    expect(await resolveAnalyticsMerchantId()).toBe("M-loc-1");
    expect(merchantIdForLocationMock).toHaveBeenCalledWith("loc-1");
  });

  test("a specific store with no POS binding falls back to its own id", async () => {
    cookieHolder.value = "loc-2";
    merchantIdForLocationMock.mockResolvedValue(null);
    expect(await resolveAnalyticsMerchantId()).toBe("loc-2");
  });
});
