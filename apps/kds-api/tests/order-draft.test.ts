import type { Redis } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { loadDraft, saveDraft, type OrderDraft } from "../src/lib/order-draft.js";

// Minimal stateful Redis — loadDraft/saveDraft only touch get/set. Mirrors the
// helper in order-routes.test.ts; `set` ignores the trailing EX/ttl args.
function makeRedis() {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

// Same key scheme as order-draft.ts (keyFor), so we can plant raw/garbage bytes
// at the exact key loadDraft reads back.
const draftKey = (id: string) => `order:draft:${id}`;

// A fully-normalized, contract-valid draft (every default already present), so a
// save → load round-trip is a stable deep-equal.
const VALID_DRAFT: OrderDraft = {
  merchantId: "M1",
  locationId: null,
  order: {
    customerName: "Jamie",
    lines: [
      {
        lineId: "l1",
        itemId: "I1",
        itemName: "Strawberry Roll",
        unitPriceCents: 899,
        quantity: 1,
        modifiers: [],
      },
    ],
  },
  lines: [{ name: "Strawberry Roll", unitPriceCents: 899, quantity: 1, modifierNames: [] }],
  totals: { subtotalCents: 899, taxCents: 88, tipCents: 0, totalCents: 987, currency: "USD" },
};

describe("loadDraft", () => {
  it("round-trips a valid draft saved by saveDraft", async () => {
    const redis = makeRedis();
    await saveDraft(redis as unknown as Redis, "d1", VALID_DRAFT);
    expect(await loadDraft(redis as unknown as Redis, "d1")).toEqual(VALID_DRAFT);
  });

  it("returns null when the key is missing (expired / never saved)", async () => {
    const redis = makeRedis();
    expect(await loadDraft(redis as unknown as Redis, "missing")).toBeNull();
  });

  it("returns null on malformed (non-JSON) draft data", async () => {
    const redis = makeRedis();
    redis.set(draftKey("garbage"), "{not valid json");
    expect(await loadDraft(redis as unknown as Redis, "garbage")).toBeNull();
  });

  it("returns null when JSON is well-formed but the money is tampered", async () => {
    const redis = makeRedis();
    // totalCents flipped to a string — the exact value the charge path must never
    // trust. Parses as JSON, but fails OrderTotalsSchema (int ≥ 0), so it never
    // reaches `draft.totals.totalCents + tipCents`.
    redis.set(
      draftKey("tampered"),
      JSON.stringify({ ...VALID_DRAFT, totals: { ...VALID_DRAFT.totals, totalCents: "9999" } }),
    );
    expect(await loadDraft(redis as unknown as Redis, "tampered")).toBeNull();
  });

  it("returns null when a security-critical id field is the wrong type", async () => {
    const redis = makeRedis();
    // merchantId as a number would slip past a bare `as OrderDraft` cast and feed
    // the per-store payment gate (draft.merchantId !== configuredMerchantId) a
    // non-string.
    redis.set(draftKey("badmerchant"), JSON.stringify({ ...VALID_DRAFT, merchantId: 12345 }));
    expect(await loadDraft(redis as unknown as Redis, "badmerchant")).toBeNull();
  });

  it("returns null for a JSON value that isn't an object", async () => {
    const redis = makeRedis();
    redis.set(draftKey("primitive"), "42");
    expect(await loadDraft(redis as unknown as Redis, "primitive")).toBeNull();
  });
});
