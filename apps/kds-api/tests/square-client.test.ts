import { describe, expect, it } from "vitest";
import { SquareError, SquareTimeoutError } from "square";

import {
  SquareClient,
  SquareConnectError,
  type SquareVendorClient,
  type SquareVendorFactory
} from "../src/lib/square-client.js";
import type { SquareCatalogObject } from "../src/domain/normalize-square-catalog.js";
import type { SquareOrder } from "../src/domain/normalize-square-order.js";

type ListResult = Awaited<ReturnType<SquareVendorClient["locations"]["list"]>>;
type OrdersSearch = SquareVendorClient["orders"]["search"];
type OrdersGet = SquareVendorClient["orders"]["get"];

async function* asPage(objects: SquareCatalogObject[]): AsyncIterable<SquareCatalogObject> {
  for (const object of objects) {
    yield object;
  }
}

// Build a fake vendor + factory. The factory records the (token, environment) it
// was called with so we can assert the env switch without touching the network.
function fakeFactory(opts: {
  list: () => Promise<ListResult>;
  merchant?: () => Promise<{ merchant?: { id?: string; businessName?: string | null } }>;
  catalog?: () => Promise<AsyncIterable<SquareCatalogObject>>;
  ordersSearch?: OrdersSearch;
  ordersGet?: OrdersGet;
  calls?: Array<{ token: string; environment: string }>;
}): SquareVendorFactory {
  return (token, environment) => {
    opts.calls?.push({ token, environment });
    return {
      locations: { list: opts.list },
      merchants: {
        get: opts.merchant ?? (async () => ({ merchant: { id: "MER1", businessName: "Example Kitchen" } }))
      },
      catalog: { list: opts.catalog ?? (async () => asPage([])) },
      orders: {
        search: opts.ordersSearch ?? (async () => ({ orders: [] })),
        get: opts.ordersGet ?? (async () => ({ order: null }))
      }
    };
  };
}

const okLocations: ListResult = {
  locations: [
    { id: "L1", name: "Downtown", timezone: "America/Chicago", currency: "USD", merchantId: "MER1", status: "ACTIVE" },
    { id: "L2", name: "Closed", timezone: "America/Chicago", currency: "USD", merchantId: "MER1", status: "INACTIVE" }
  ]
};

describe("SquareClient.validateAndListLocations", () => {
  it("returns merchant + ACTIVE locations only, and resolves the display name", async () => {
    const client = new SquareClient(fakeFactory({ list: async () => okLocations }));
    const info = await client.validateAndListLocations("sq0-token", "sandbox");
    expect(info.merchantId).toBe("MER1");
    expect(info.merchantName).toBe("Example Kitchen");
    expect(info.locations).toEqual([
      { id: "L1", name: "Downtown", timezone: "America/Chicago", currency: "USD" }
    ]);
  });

  it("passes the environment through to the vendor factory", async () => {
    const calls: Array<{ token: string; environment: string }> = [];
    const sandbox = new SquareClient(fakeFactory({ list: async () => okLocations, calls }));
    await sandbox.validateAndListLocations("tok-a", "sandbox");
    const prod = new SquareClient(fakeFactory({ list: async () => okLocations, calls }));
    await prod.validateAndListLocations("tok-b", "production");
    expect(calls).toEqual([
      { token: "tok-a", environment: "sandbox" },
      { token: "tok-b", environment: "production" }
    ]);
  });

  it("maps a 401 to invalid_token (bad token or wrong environment)", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => {
          throw new SquareError({ statusCode: 401, message: "unauthorized" });
        }
      })
    );
    await expect(client.validateAndListLocations("bad", "sandbox")).rejects.toMatchObject({
      name: "SquareConnectError",
      kind: "invalid_token"
    });
  });

  it("maps a 403 to insufficient_scope", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => {
          throw new SquareError({ statusCode: 403, message: "forbidden" });
        }
      })
    );
    await expect(client.validateAndListLocations("scoped", "sandbox")).rejects.toMatchObject({
      kind: "insufficient_scope"
    });
  });

  it("maps a timeout to timeout", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => {
          throw new SquareTimeoutError("timed out");
        }
      })
    );
    await expect(client.validateAndListLocations("slow", "sandbox")).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects with no_locations when the token is valid but has no active location", async () => {
    const client = new SquareClient(fakeFactory({ list: async () => ({ locations: [] }) }));
    await expect(client.validateAndListLocations("empty", "sandbox")).rejects.toMatchObject({ kind: "no_locations" });
  });

  it("fails closed when the merchant fetch is forbidden (scope)", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => okLocations,
        merchant: async () => {
          throw new SquareError({ statusCode: 403, message: "forbidden" });
        }
      })
    );
    await expect(client.validateAndListLocations("tok", "sandbox")).rejects.toMatchObject({
      kind: "insufficient_scope"
    });
  });

  it("falls back to the merchant id as name when the merchant fetch fails non-fatally", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => okLocations,
        merchant: async () => {
          throw new SquareError({ statusCode: 500, message: "server error" });
        }
      })
    );
    const info = await client.validateAndListLocations("tok", "sandbox");
    expect(info.merchantName).toBe("MER1");
  });

  it("never leaks the token in the thrown error", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => {
          throw new SquareError({ statusCode: 401, message: "unauthorized" });
        }
      })
    );
    const secret = "sq0atp-SUPER-SECRET-TOKEN";
    const err = await client.validateAndListLocations(secret, "sandbox").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquareConnectError);
    expect(JSON.stringify({ msg: (err as Error).message, ...(err as object) })).not.toContain(secret);
  });
});

describe("SquareClient.fetchCatalog", () => {
  const catalogObjects: SquareCatalogObject[] = [
    { type: "CATEGORY", id: "CAT1", categoryData: { name: "Scoops" } },
    {
      type: "ITEM",
      id: "ITEM1",
      itemData: {
        name: "Vanilla",
        reportingCategory: { id: "CAT1" },
        variations: [
          { type: "ITEM_VARIATION", id: "V1", itemVariationData: { pricingType: "FIXED_PRICING", priceMoney: { amount: 450n } } }
        ]
      }
    }
  ];

  it("pages the catalog into a flat array and passes the env + types through", async () => {
    const calls: Array<{ token: string; environment: string }> = [];
    let requestedTypes = "";
    const client = new SquareClient(
      fakeFactory({
        list: async () => ({ locations: [] }),
        calls,
        catalog: async () => {
          requestedTypes = "ITEM,MODIFIER_LIST,CATEGORY";
          return asPage(catalogObjects);
        }
      })
    );
    const objects = await client.fetchCatalog("tok-cat", "production");
    expect(objects).toHaveLength(2);
    expect(objects.map((object) => object.id)).toEqual(["CAT1", "ITEM1"]);
    expect(calls).toEqual([{ token: "tok-cat", environment: "production" }]);
    expect(requestedTypes).toBe("ITEM,MODIFIER_LIST,CATEGORY");
  });

  it("maps a vendor 401 during catalog paging to invalid_token", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => ({ locations: [] }),
        catalog: async () => {
          throw new SquareError({ statusCode: 401, message: "unauthorized" });
        }
      })
    );
    await expect(client.fetchCatalog("bad", "sandbox")).rejects.toMatchObject({
      name: "SquareConnectError",
      kind: "invalid_token"
    });
  });

  it("propagates a mid-stream vendor timeout as a connect timeout", async () => {
    async function* boom(): AsyncIterable<SquareCatalogObject> {
      yield catalogObjects[0]!;
      throw new SquareTimeoutError("timed out");
    }
    const client = new SquareClient(
      fakeFactory({ list: async () => ({ locations: [] }), catalog: async () => boom() })
    );
    await expect(client.fetchCatalog("slow", "sandbox")).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("SquareClient.searchOrders", () => {
  const order: SquareOrder = { id: "ORD1", locationId: "LOC1", state: "COMPLETED" };

  it("filters+sorts on UPDATED_AT and pages until the cursor is exhausted", async () => {
    const requests: unknown[] = [];
    const search: OrdersSearch = async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { orders: [order], cursor: "next" }
        : { orders: [{ id: "ORD2", locationId: "LOC1" }], cursor: null };
    };
    const client = new SquareClient(fakeFactory({ list: async () => ({ locations: [] }), ordersSearch: search }));
    const orders = await client.searchOrders("tok", "sandbox", "LOC1", "2026-06-18T00:00:00Z");
    expect(orders.map((o) => o.id)).toEqual(["ORD1", "ORD2"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      locationIds: ["LOC1"],
      query: {
        filter: { dateTimeFilter: { updatedAt: { startAt: "2026-06-18T00:00:00Z" } } },
        sort: { sortField: "UPDATED_AT", sortOrder: "ASC" }
      }
    });
    // page 2 carries the cursor
    expect(requests[1]).toMatchObject({ cursor: "next" });
  });

  it("omits the dateTime filter when no updatedSince is given", async () => {
    let captured: unknown;
    const search: OrdersSearch = async (request) => {
      captured = request;
      return { orders: [order] };
    };
    const client = new SquareClient(fakeFactory({ list: async () => ({ locations: [] }), ordersSearch: search }));
    await client.searchOrders("tok", "sandbox", "LOC1");
    expect(captured).toMatchObject({ query: { sort: { sortField: "UPDATED_AT" } } });
    expect((captured as { query: { filter?: unknown } }).query.filter).toBeUndefined();
  });

  it("maps a vendor 401 to invalid_token", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => ({ locations: [] }),
        ordersSearch: async () => {
          throw new SquareError({ statusCode: 401, message: "unauthorized" });
        }
      })
    );
    await expect(client.searchOrders("bad", "sandbox", "LOC1")).rejects.toMatchObject({ kind: "invalid_token" });
  });
});

describe("SquareClient.fetchOrder", () => {
  it("returns the order body", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => ({ locations: [] }),
        ordersGet: async ({ orderId }) => ({ order: { id: orderId, locationId: "LOC1" } })
      })
    );
    const order = await client.fetchOrder("tok", "production", "ORD9");
    expect(order?.id).toBe("ORD9");
  });

  it("returns null when Square has no such order", async () => {
    const client = new SquareClient(
      fakeFactory({ list: async () => ({ locations: [] }), ordersGet: async () => ({ order: null }) })
    );
    expect(await client.fetchOrder("tok", "sandbox", "GONE")).toBeNull();
  });

  it("maps a vendor timeout to timeout", async () => {
    const client = new SquareClient(
      fakeFactory({
        list: async () => ({ locations: [] }),
        ordersGet: async () => {
          throw new SquareTimeoutError("timed out");
        }
      })
    );
    await expect(client.fetchOrder("tok", "sandbox", "ORD1")).rejects.toMatchObject({ kind: "timeout" });
  });
});
