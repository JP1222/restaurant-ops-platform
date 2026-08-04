import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config.js";
import type { SyncTarget, SyncTargetsReader } from "../src/sync-targets/repository.js";
import type { JsonRecord } from "../src/types.js";
import { SquareClient, toJsonSafe, type SquareVendorClient } from "../src/square/client.js";
import { SquareClientFactory, squareLocationIdFromMerchantId } from "../src/square/client-factory.js";

async function* asPage(items: JsonRecord[]): AsyncIterable<JsonRecord> {
  for (const item of items) {
    yield item;
  }
}

function fakeVendor(over: Partial<SquareVendorClient> = {}): SquareVendorClient {
  return {
    orders: { search: over.orders?.search ?? (async () => ({ orders: [] })) },
    payments: { list: over.payments?.list ?? (async () => asPage([])) },
    refunds: { list: over.refunds?.list ?? (async () => asPage([])) },
  };
}

describe("toJsonSafe", () => {
  it("deep-coerces bigint → number through objects and arrays (the v44 jsonb footgun)", () => {
    const input = {
      totalMoney: { amount: 1075n, currency: "USD" },
      lineItems: [{ basePriceMoney: { amount: 550n } }, { basePriceMoney: { amount: 250n } }],
      version: 3n,
      name: "Vanilla",
      missing: null,
    };
    const safe = toJsonSafe(input);
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(safe).toEqual({
      totalMoney: { amount: 1075, currency: "USD" },
      lineItems: [{ basePriceMoney: { amount: 550 } }, { basePriceMoney: { amount: 250 } }],
      version: 3,
      name: "Vanilla",
      missing: null,
    });
  });
});

describe("SquareClient.listOrders", () => {
  it("filters+sorts on UPDATED_AT, pages the cursor, and returns JSON-safe payloads", async () => {
    const requests: unknown[] = [];
    const search: SquareVendorClient["orders"]["search"] = async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { orders: [{ id: "O1", totalMoney: { amount: 500n } }], cursor: "next" }
        : { orders: [{ id: "O2", totalMoney: { amount: 250n } }], cursor: null };
    };
    const client = new SquareClient("LOC1", fakeVendor({ orders: { search } }));
    const orders = await client.listOrders(new Date("2026-06-18T00:00:00.000Z"));

    expect(orders.map((o) => o.id)).toEqual(["O1", "O2"]);
    expect(() => JSON.stringify(orders)).not.toThrow();
    expect((orders[0]!.totalMoney as JsonRecord).amount).toBe(500); // bigint → number
    expect(requests[0]).toMatchObject({
      locationIds: ["LOC1"],
      query: {
        filter: { dateTimeFilter: { updatedAt: { startAt: "2026-06-18T00:00:00.000Z" } } },
        sort: { sortField: "UPDATED_AT", sortOrder: "ASC" },
      },
    });
    expect(requests[1]).toMatchObject({ cursor: "next" });
  });
});

describe("SquareClient.listPayments / listRefunds", () => {
  it("pages the SDK Page and coerces bigint money", async () => {
    const client = new SquareClient(
      "LOC1",
      fakeVendor({
        payments: { list: async () => asPage([{ id: "P1", amountMoney: { amount: 999n } }]) },
        refunds: { list: async () => asPage([{ id: "R1", amountMoney: { amount: 100n } }]) },
      })
    );
    const payments = await client.listPayments(new Date("2026-06-18T00:00:00Z"));
    const refunds = await client.listRefunds(new Date("2026-06-18T00:00:00Z"));
    expect((payments[0]!.amountMoney as JsonRecord).amount).toBe(999);
    expect((refunds[0]!.amountMoney as JsonRecord).amount).toBe(100);
    expect(() => JSON.stringify([payments, refunds])).not.toThrow();
  });
});

describe("squareLocationIdFromMerchantId", () => {
  it("strips the square: prefix", () => {
    expect(squareLocationIdFromMerchantId("square:LV78H3YNW202D")).toBe("LV78H3YNW202D");
    expect(squareLocationIdFromMerchantId("LV78H3YNW202D")).toBe("LV78H3YNW202D");
  });
});

describe("SquareClientFactory", () => {
  const config = { squareEnvironment: "sandbox" } as AppConfig;

  function syncTargets(target: SyncTarget | null): SyncTargetsReader {
    return { get: vi.fn(async () => target) } as unknown as SyncTargetsReader;
  }

  const squareTarget: SyncTarget = {
    merchantId: "square:LOC1",
    provider: "square",
    token: "sq-token",
    storeTimezone: "UTC",
    active: true,
  };

  it("builds a client with the token from sync_targets + the location parsed from the id", async () => {
    const calls: Array<{ token: string; environment: string }> = [];
    const factory = new SquareClientFactory(config, syncTargets(squareTarget), (token, environment) => {
      calls.push({ token, environment });
      return fakeVendor();
    });
    const client = await factory.get("square:LOC1");
    expect(client).toBeInstanceOf(SquareClient);
    expect(calls).toEqual([{ token: "sq-token", environment: "sandbox" }]);
  });

  it("caches per merchant and rebuilds on token rotation", async () => {
    let current: SyncTarget = { ...squareTarget };
    const reader = { get: async () => current } as unknown as SyncTargetsReader;
    let builds = 0;
    const factory = new SquareClientFactory(config, reader, () => {
      builds += 1;
      return fakeVendor();
    });
    const a = await factory.get("square:LOC1");
    const b = await factory.get("square:LOC1");
    expect(a).toBe(b); // cached
    expect(builds).toBe(1);
    current = { ...squareTarget, token: "rotated" };
    const c = await factory.get("square:LOC1");
    expect(c).not.toBe(a); // rebuilt on token change
    expect(builds).toBe(2);
  });

  it("throws for a missing target or a non-Square provider", async () => {
    await expect(new SquareClientFactory(config, syncTargets(null)).get("square:LOC1")).rejects.toThrow(
      /No active sync target/
    );
    await expect(
      new SquareClientFactory(config, syncTargets({ ...squareTarget, provider: "clover" })).get("square:LOC1")
    ).rejects.toThrow(/not a Square store/);
  });
});
