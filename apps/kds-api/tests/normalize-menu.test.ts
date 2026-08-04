import { describe, expect, it } from "vitest";
import { OrderMenuResponseSchema } from "@rop/contracts";
import { normalizeMenu } from "../src/domain/normalize-menu.js";

const ITEMS = {
  elements: [
    {
      id: "I1",
      name: "Strawberry Roll",
      price: 899,
      hidden: false,
      available: true,
      categories: { elements: [{ id: "C1", name: "Signature Rolls" }] },
      modifierGroups: { elements: [{ id: "G1", name: "Toppings" }] },
    },
    {
      id: "I2",
      name: "Hidden Item",
      price: 500,
      hidden: true,
      categories: { elements: [{ id: "C1", name: "Signature Rolls" }] },
    },
    {
      id: "I3",
      name: "Unavailable Drink",
      price: 300,
      available: false,
      categories: { elements: [{ id: "C2", name: "Drinks" }] },
    },
    {
      id: "I4",
      name: "Mango Roll",
      price: 999,
      // hidden/available absent → included by default
      categories: { elements: [{ id: "C2", name: "Drinks" }] },
    },
  ],
};

const MODIFIER_GROUPS = {
  elements: [
    {
      id: "G1",
      name: "Toppings",
      minRequired: 0,
      maxAllowed: 0, // 0 = unlimited → falls back to the available-choice count
      modifiers: {
        elements: [
          { id: "M1", name: "Oreo", price: 50, available: true },
          { id: "M2", name: "Mochi", price: 75, available: true },
          { id: "M3", name: "Sold Out", price: 50, available: false },
        ],
      },
    },
  ],
};

describe("normalizeMenu", () => {
  it("maps available Clover items + joins modifier groups (cents, no POS fields)", () => {
    const menu = normalizeMenu(ITEMS, MODIFIER_GROUPS);

    expect(menu.items.map((item) => item.id)).toEqual(["I1", "I4"]); // I2 hidden, I3 unavailable
    const roll = menu.items.find((item) => item.id === "I1");
    expect(roll).toMatchObject({
      name: "Strawberry Roll",
      priceCents: 899,
      category: "Signature Rolls",
      description: null,
      imageUrl: null,
      available: true,
    });
    expect(roll?.modifierGroups).toEqual([
      {
        id: "G1",
        name: "Toppings",
        minSelections: 0,
        maxSelections: 2, // maxAllowed 0 → number of available choices
        modifiers: [
          { id: "M1", name: "Oreo", priceDeltaCents: 50, group: "Toppings" },
          { id: "M2", name: "Mochi", priceDeltaCents: 75, group: "Toppings" }, // M3 unavailable dropped
        ],
      },
    ]);
  });

  it("lists categories in first-seen order", () => {
    expect(normalizeMenu(ITEMS, MODIFIER_GROUPS).categories).toEqual([
      "Signature Rolls",
      "Drinks",
    ]);
  });

  it("defaults category to Menu, tolerates missing fields, and skips id-less items", () => {
    const menu = normalizeMenu({ elements: [{ id: "X", name: "Bare" }, { name: "No Id" }] }, {});
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({
      id: "X",
      category: "Menu",
      priceCents: 0,
      modifierGroups: [],
    });
  });

  it("produces a contract-valid OrderMenuResponse", () => {
    expect(OrderMenuResponseSchema.safeParse(normalizeMenu(ITEMS, MODIFIER_GROUPS)).success).toBe(
      true,
    );
  });
});
