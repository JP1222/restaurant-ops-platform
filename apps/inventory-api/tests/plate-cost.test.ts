import { describe, expect, it } from "vitest";
import { computePlateCosts, type RecipeForCosting } from "../src/lib/plate-cost.js";

const EFF = "2026-06-02T00:00:00.000Z";

describe("computePlateCosts", () => {
  it("sums qty x per-usage cost for a complete, Clover-linked recipe", () => {
    const recipes: RecipeForCosting[] = [
      { cloverItemId: "clv-vanilla", lines: [{ sku: "cup", qty: 1 }, { sku: "base", qty: 4 }] },
    ];
    // per-usage costs are Floats (sub-cent): 1*5.2 + 4*30 = 125.2
    const costBySku = new Map([
      ["cup", 5.2],
      ["base", 30],
    ]);
    expect(computePlateCosts(recipes, costBySku, EFF)).toEqual([
      { clover_item_id: "clv-vanilla", plate_cost_cents: 125.2, currency: "USD", effective_from: EFF },
    ]);
  });

  it("omits a recipe whose ingredient has no known cost — never treats it as $0", () => {
    const recipes: RecipeForCosting[] = [
      { cloverItemId: "clv-x", lines: [{ sku: "known", qty: 1 }, { sku: "orphan", qty: 1 }] },
    ];
    expect(computePlateCosts(recipes, new Map([["known", 50]]), EFF)).toEqual([]);
  });

  it("omits an empty BOM and a recipe with no Clover link", () => {
    const recipes: RecipeForCosting[] = [
      { cloverItemId: "clv-empty", lines: [] },
      { cloverItemId: null, lines: [{ sku: "cup", qty: 1 }] },
    ];
    expect(computePlateCosts(recipes, new Map([["cup", 5]]), EFF)).toEqual([]);
  });

  it("treats a known cost of exactly 0 as valid (free ingredient)", () => {
    const recipes: RecipeForCosting[] = [
      { cloverItemId: "clv-water", lines: [{ sku: "tap", qty: 1 }, { sku: "cup", qty: 1 }] },
    ];
    const out = computePlateCosts(recipes, new Map([["tap", 0], ["cup", 6]]), EFF);
    expect(out).toHaveLength(1);
    expect(out[0]?.plate_cost_cents).toBe(6);
  });
});
