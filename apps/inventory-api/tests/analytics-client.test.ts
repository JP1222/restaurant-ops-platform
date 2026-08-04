import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnalyticsFeedAuthError,
  buildAnalyticsSoldItemsFetcher
} from "../src/lib/analytics-client.js";

// GH #468: a wrong/stale ANALYTICS_ADMIN_TOKEN makes analytics-api answer 401/403.
// These prove the fetcher throws a TYPED auth error (so the sync-sales route can
// return a clear 502 instead of an opaque 500), while other failures stay generic.

const cfg = { baseUrl: "https://analytics.internal", token: "bad", merchantId: "M1" };

function fetchReturning(status: number) {
  return vi.fn(
    async () => new Response(status === 200 ? "{}" : "nope", { status })
  );
}

describe("buildAnalyticsSoldItemsFetcher auth-error mapping (GH #468)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws AnalyticsFeedAuthError on 401", async () => {
    vi.stubGlobal("fetch", fetchReturning(401));
    const fetchSoldItems = buildAnalyticsSoldItemsFetcher(cfg);
    await expect(fetchSoldItems(null)).rejects.toBeInstanceOf(AnalyticsFeedAuthError);
    await expect(fetchSoldItems(null)).rejects.toMatchObject({ status: 401 });
  });

  it("throws AnalyticsFeedAuthError on 403", async () => {
    vi.stubGlobal("fetch", fetchReturning(403));
    const fetchSoldItems = buildAnalyticsSoldItemsFetcher(cfg);
    await expect(fetchSoldItems(null)).rejects.toBeInstanceOf(AnalyticsFeedAuthError);
  });

  it("throws a generic (non-auth) error on 500 so only token rejections map to 502", async () => {
    vi.stubGlobal("fetch", fetchReturning(500));
    const fetchSoldItems = buildAnalyticsSoldItemsFetcher(cfg);
    const err = await fetchSoldItems(null).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AnalyticsFeedAuthError);
  });
});

// The feed rows are snake_case (the shared contract); the worker consumes the
// camelCase SoldMenuItem shape. These prove the mapping — and specifically that the
// provider catalog id routes to the right field (clover vs square, #790), since the
// depletion join keys off exactly that.
describe("buildAnalyticsSoldItemsFetcher row mapping", () => {
  afterEach(() => vi.unstubAllGlobals());

  function feedReturning(body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  }

  it("routes a Square row's id to squareCatalogObjectId and omits cloverItemId", async () => {
    vi.stubGlobal(
      "fetch",
      feedReturning({
        items: [
          {
            line_item_id: "li-sq",
            clover_item_id: null,
            square_catalog_item_id: "SQ_VANILLA",
            item_name: "Vanilla Roll",
            quantity: 2,
            modifiers: ["Extra Boba"]
          }
        ],
        cursor: "2026-06-18T00:00:00.000Z"
      })
    );
    const { soldItems, nextCursor } = await buildAnalyticsSoldItemsFetcher(cfg)(null);

    expect(soldItems).toHaveLength(1);
    expect(soldItems[0]).toEqual({
      lineItemId: "li-sq",
      itemName: "Vanilla Roll",
      quantity: 2,
      modifierNames: ["Extra Boba"],
      squareCatalogObjectId: "SQ_VANILLA"
    });
    // Exact-optional: the absent id is omitted, not set to undefined.
    expect(soldItems[0]).not.toHaveProperty("cloverItemId");
    expect(nextCursor).toBe("2026-06-18T00:00:00.000Z");
  });

  it("routes a Clover row's id to cloverItemId and omits squareCatalogObjectId", async () => {
    vi.stubGlobal(
      "fetch",
      feedReturning({
        items: [
          {
            line_item_id: "li-cl",
            clover_item_id: "CLV1",
            square_catalog_item_id: null,
            item_name: "Mango Roll",
            quantity: 1,
            modifiers: []
          }
        ],
        cursor: null
      })
    );
    const { soldItems } = await buildAnalyticsSoldItemsFetcher(cfg)(null);

    expect(soldItems[0]).toMatchObject({ cloverItemId: "CLV1" });
    expect(soldItems[0]).not.toHaveProperty("squareCatalogObjectId");
  });
});
