import { afterEach, describe, expect, it, vi } from "vitest";

import { categoryFromOff, lookupOff, unitFromQuantity } from "../src/lib/off-lookup.js";

const BASE = "https://off.test";

function mockFetch(impl: (url: string) => { ok: boolean; json?: () => Promise<unknown> } | Promise<never>) {
  vi.stubGlobal("fetch", vi.fn((input: URL | string) => Promise.resolve(impl(String(input))) as never));
}

// lookupOff hits the OFF public API (v2 product endpoint). Every failure mode resolves to null so a
// miss/outage never blocks scan-to-register — the contract the route relies on to fail open.
describe("lookupOff (OFF public API)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses a found product, joining categories_tags for the category mapper", async () => {
    mockFetch((url) => {
      expect(url).toContain(`${BASE}/api/v2/product/0049000000443.json`);
      expect(url).toContain("fields=");
      return {
        ok: true,
        json: async () => ({
          status: 1,
          product: {
            product_name: "Whole Milk",
            brands: "Member's Mark",
            quantity: "1 gal",
            categories_tags: ["en:dairies", "en:milks"]
          }
        })
      };
    });
    const hit = await lookupOff("0049000000443", BASE);
    expect(hit).toEqual({
      product_name: "Whole Milk",
      brands: "Member's Mark",
      quantity: "1 gal",
      categories_en: "en:dairies,en:milks"
    });
    expect(categoryFromOff(hit!.categories_en)).toBe("dairy");
  });

  it("returns null for an unknown code (status 0)", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ status: 0 }) }));
    expect(await lookupOff("0000000000000", BASE)).toBeNull();
  });

  it("fails open on a non-200, a network error, and an empty code", async () => {
    mockFetch(() => ({ ok: false }));
    expect(await lookupOff("123", BASE)).toBeNull();

    mockFetch(() => Promise.reject(new Error("ECONNRESET")));
    expect(await lookupOff("123", BASE)).toBeNull();

    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await lookupOff("   ", BASE)).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // empty code short-circuits before any request
  });

  it("treats a hit with no usable product_name as a miss", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ status: 1, product: { quantity: "12 oz" } }) }));
    expect(await lookupOff("123", BASE)).toBeNull();
  });
});

// The OFF -> our-catalog mapping logic (barcode-onboarding ADR, D3). Pure functions, so they're
// tested without a SQLite fixture; both fail soft to null so a bad/odd OFF value never blocks the
// scan-to-register flow (the manager just fills the field).
describe("categoryFromOff", () => {
  it("maps OFF category tags to our fixed category ids", () => {
    expect(categoryFromOff("en:dairies,en:milks")).toBe("dairy");
    expect(categoryFromOff("en:beverages,en:sodas")).toBe("food");
    expect(categoryFromOff("en:syrups")).toBe("sweetener");
    expect(categoryFromOff("en:fruits")).toBe("fruit");
  });

  it("routes candy/confections to 'topping' (frozen-dessert shop), even when 'cream' is present", () => {
    expect(categoryFromOff("en:snacks,en:sweet-snacks,en:confectioneries,en:candies")).toBe("topping");
    expect(categoryFromOff("en:gummy-candies")).toBe("topping");
    // The bug class: a candy whose taxonomy contains "cream" must NOT become dairy.
    expect(categoryFromOff("en:candies,en:cream-filled-sweets")).toBe("topping");
    // But a genuine dairy "chocolate milk" stays dairy (milk wins before chocolate).
    expect(categoryFromOff("en:dairies,en:chocolate-milks")).toBe("dairy");
  });

  it("returns null for an unmapped or missing tag (manager keeps the default)", () => {
    expect(categoryFromOff("en:plastic-cups")).toBeNull();
    expect(categoryFromOff(null)).toBeNull();
  });
});

describe("unitFromQuantity", () => {
  it("parses weight / volume / count, with fl oz taking precedence over oz", () => {
    expect(unitFromQuantity("12 fl oz")).toEqual({ unit: "fl oz", unit_kind: "volume" });
    expect(unitFromQuantity("16 oz")).toEqual({ unit: "oz", unit_kind: "weight" });
    expect(unitFromQuantity("500 ml")).toEqual({ unit: "ml", unit_kind: "volume" });
    expect(unitFromQuantity("24 ct")).toEqual({ unit: "each", unit_kind: "count" });
  });

  it("returns null when no unit token is recognizable", () => {
    expect(unitFromQuantity("family size")).toBeNull();
    expect(unitFromQuantity(null)).toBeNull();
  });
});
