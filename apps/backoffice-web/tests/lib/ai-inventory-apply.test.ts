import { describe, expect, test } from "vitest";
import type { InventoryItem } from "@rop/contracts";
import {
  AiInventoryActionSchema,
  buildCountBody,
  buildReceiveBody,
  buildWasteBody,
  resolveInventoryItem,
} from "@/lib/ai/inventory-apply";

const DEFAULTS: Omit<InventoryItem, "id" | "name"> = {
  sku: "SKU",
  category: "topping",
  unit: "each",
  unit_kind: "count",
  on_hand: 10,
  par_min: 5,
  par_max: 20,
  cost_cents: 50,
  purchase_unit: "Case",
  pack_qty: 1,
  purchase_cost_cents: 5000,
  vendor: "Acme",
  shelf_days: 30,
  last_counted: "2026-06-01",
  flagged_86: false,
  archived: false,
};

function mkItem(over: Partial<InventoryItem> & Pick<InventoryItem, "id" | "name">): InventoryItem {
  return { ...DEFAULTS, ...over };
}

const ITEMS = [
  mkItem({ id: "itm_pearls", name: "Tapioca Pearls", sku: "TAP1", category: "topping" }),
  mkItem({ id: "itm_milk", name: "Whole Milk", sku: "MLK", category: "dairy", cost_cents: 5.2 }),
  mkItem({ id: "itm_cup16", name: "16oz Cups", sku: "CUP16", category: "packaging" }),
  mkItem({ id: "itm_cup12", name: "12oz Cups", sku: "CUP12", category: "packaging" }),
];

describe("resolveInventoryItem", () => {
  test("resolves an exact item id", () => {
    const r = resolveInventoryItem({ items: ITEMS }, "itm_milk");
    expect(r.ok && r.item.name).toBe("Whole Milk");
  });

  test("resolves a unique exact SKU (case-insensitive)", () => {
    const r = resolveInventoryItem({ items: ITEMS }, "tap1");
    expect(r.ok && r.item.id).toBe("itm_pearls");
  });

  test("resolves a unique exact name (case-insensitive)", () => {
    const r = resolveInventoryItem({ items: ITEMS }, "whole milk");
    expect(r.ok && r.item.id).toBe("itm_milk");
  });

  test("resolves a unique substring", () => {
    const r = resolveInventoryItem({ items: ITEMS }, "pearl");
    expect(r.ok && r.item.id).toBe("itm_pearls");
  });

  test("returns ambiguous with candidates when a substring matches several", () => {
    const r = resolveInventoryItem({ items: ITEMS }, "cups");
    expect(r.ok).toBe(false);
    if (!r.ok && r.error === "ambiguous") {
      expect(r.candidates.sort()).toEqual(["12oz Cups", "16oz Cups"]);
    } else {
      throw new Error("expected ambiguous");
    }
  });

  test("returns not_found for no match and for empty query", () => {
    expect(resolveInventoryItem({ items: ITEMS }, "espresso").ok).toBe(false);
    expect(resolveInventoryItem({ items: ITEMS }, "   ").ok).toBe(false);
  });

  test("excludes archived items", () => {
    const items = [...ITEMS, mkItem({ id: "old", name: "Old Pearls", sku: "OLD", archived: true })];
    const r = resolveInventoryItem({ items }, "old pearls");
    expect(r.ok).toBe(false);
  });
});

describe("body builders key the item by id", () => {
  const milk = ITEMS[1]!; // cost_cents 5.2
  const cup = ITEMS[2]!;

  test("buildReceiveBody → ad-hoc receive line keyed by item id", () => {
    const body = buildReceiveBody(cup, 5, "op", "tc_1", "Sysco");
    expect(body).toEqual({
      who: "op",
      idempotency_key: "tc_1",
      vendor: "Sysco",
      lines: [{ sku: "itm_cup16", qty: 5 }],
    });
  });

  test("buildWasteBody → cost rounded to int cents, photo false, keyed by id", () => {
    const body = buildWasteBody(milk, 3, "spoilage", "op", "tc_2", "left out");
    expect(body).toEqual({
      sku: "itm_milk",
      qty: 3,
      reason: "spoilage",
      notes: "left out",
      photo: false,
      cost_cents: 16, // round(5.2 * 3)
      who: "op",
      idempotency_key: "tc_2",
    });
  });

  test("buildCountBody → updates map keyed by item id", () => {
    const body = buildCountBody(cup, 7, "op", "tc_3");
    expect(body).toEqual({
      updates: { itm_cup16: 7 },
      who: "op",
      idempotency_key: "tc_3",
    });
  });
});

describe("AiInventoryActionSchema", () => {
  test("accepts valid receive / waste / count", () => {
    expect(
      AiInventoryActionSchema.safeParse({
        action: "receive",
        item: "cups",
        quantity: 5,
        idempotency_key: "tc",
      }).success,
    ).toBe(true);
    expect(
      AiInventoryActionSchema.safeParse({
        action: "waste",
        item: "milk",
        quantity: 2,
        reason: "spoilage",
        idempotency_key: "tc",
      }).success,
    ).toBe(true);
    expect(
      AiInventoryActionSchema.safeParse({
        action: "count",
        item: "straws",
        counted_quantity: 0,
        idempotency_key: "tc",
      }).success,
    ).toBe(true);
  });

  test("rejects bad payloads (missing key, bad reason, non-positive qty)", () => {
    expect(
      AiInventoryActionSchema.safeParse({ action: "receive", item: "cups", quantity: 5 }).success,
    ).toBe(false); // missing idempotency_key
    expect(
      AiInventoryActionSchema.safeParse({
        action: "waste",
        item: "milk",
        quantity: 2,
        reason: "bogus",
        idempotency_key: "tc",
      }).success,
    ).toBe(false);
    expect(
      AiInventoryActionSchema.safeParse({
        action: "receive",
        item: "cups",
        quantity: 0,
        idempotency_key: "tc",
      }).success,
    ).toBe(false);
  });
});
