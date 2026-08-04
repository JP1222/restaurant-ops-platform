import { describe, expect, it } from "vitest";
import type { CreateOrderRequest, OrderMenuResponse } from "@rop/contracts";
import { priceCart } from "../src/domain/price-cart.js";

const MENU: OrderMenuResponse = {
  categories: ["Signature Rolls"],
  items: [
    {
      id: "I1",
      name: "Strawberry Roll",
      description: null,
      priceCents: 899,
      category: "Signature Rolls",
      imageUrl: null,
      available: true,
      modifierGroups: [
        {
          id: "G1",
          name: "Toppings",
          minSelections: 0,
          maxSelections: 2,
          modifiers: [
            { id: "M1", name: "Oreo", priceDeltaCents: 50, group: "Toppings" },
            { id: "M2", name: "Mochi", priceDeltaCents: 75, group: "Toppings" },
          ],
        },
      ],
    },
    {
      id: "I2",
      name: "Sold Out Roll",
      description: null,
      priceCents: 999,
      category: "Signature Rolls",
      imageUrl: null,
      available: false,
      modifierGroups: [],
    },
  ],
};

type Line = CreateOrderRequest["lines"][number];

function line(over: Partial<Line> = {}): Line {
  return {
    lineId: "l1",
    itemId: "I1",
    itemName: "Strawberry Roll",
    unitPriceCents: 0,
    quantity: 1,
    modifiers: [],
    ...over,
  };
}

function request(lines: Line[]): CreateOrderRequest {
  return { customerName: "Jamie", lines };
}

describe("priceCart", () => {
  it("prices from the catalog (base + modifier deltas), ignoring the client price", () => {
    const result = priceCart(
      request([
        line({
          unitPriceCents: 1, // tampered client price — must be ignored
          quantity: 2,
          modifiers: [{ id: "M1", name: "whatever", priceDeltaCents: 9999 }], // delta also ignored
        }),
      ]),
      MENU,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cart.lines[0]).toMatchObject({
      name: "Strawberry Roll",
      unitPriceCents: 949, // 899 base + 50 catalog modifier — NOT 1 or 9999
      quantity: 2,
    });
    expect(result.cart.subtotalCents).toBe(1898); // 949 * 2
  });

  it("rejects an unavailable item", () => {
    const result = priceCart(request([line({ itemId: "I2", itemName: "Sold Out Roll" })]), MENU);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no longer available/i);
    expect(result.lineId).toBe("l1");
  });

  it("rejects an item missing from the catalog", () => {
    expect(priceCart(request([line({ itemId: "GONE" })]), MENU).ok).toBe(false);
  });

  it("rejects an unknown modifier", () => {
    const result = priceCart(
      request([line({ modifiers: [{ id: "MX", name: "ghost", priceDeltaCents: 0 }] })]),
      MENU,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/option/i);
  });
});
