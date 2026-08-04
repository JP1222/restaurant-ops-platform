import { describe, expect, it } from "vitest";
import { buildOrderCart } from "../src/domain/build-order-cart.js";

const LINES = [
  { name: "Strawberry Roll", unitPriceCents: 899, quantity: 2, modifierNames: ["Oreo"] },
  { name: "Mango Roll", unitPriceCents: 999, quantity: 1, modifierNames: [] },
];

describe("buildOrderCart", () => {
  it("expands quantity into repeated ad-hoc line items", () => {
    const cart = buildOrderCart(LINES, null);
    expect(cart.lineItems).toEqual([
      { name: "Strawberry Roll", price: 899 },
      { name: "Strawberry Roll", price: 899 },
      { name: "Mango Roll", price: 999 },
    ]);
    // No inline orderType — Clover rejects those; omit when there is no order type.
    expect(cart.orderType).toBeUndefined();
  });

  it("references the order type by id when provided (so Clover applies tax)", () => {
    expect(buildOrderCart(LINES, "OT1").orderType).toEqual({ id: "OT1" });
  });
});
