import { describe, expect, it } from "vitest";
import { buildSearchText, buildStableItemKey, normalizeOrder } from "../src/domain/normalize-order.js";

describe("normalizeOrder", () => {
  it("normalizes line items, modifiers, and metadata", () => {
    const order = normalizeOrder(
      {
        id: "ORDER123456",
        displayCode: "147",
        clientCreatedTime: 1_700_000_000_000,
        modifiedTime: 1_700_000_120_000,
        note: "No peanuts",
        source: "Online pickup",
        orderType: { label: "Pickup" },
        lineItems: {
          elements: [
            {
              id: "line-1",
              name: "Loaded Fries",
              unitQty: 2,
              note: "extra crisp",
              modifiers: {
                elements: [{ name: "Jalapeno" }, { modifier: { name: "Bacon" } }]
              }
            }
          ]
        }
      },
      "MERCHANT-1"
    );

    expect(order.provider).toBe("clover");
    expect(order.sourceOrderId).toBe("ORDER123456");
    expect(order.orderLabel).toBe("#147");
    expect(order.priority).toBe(2);
    expect(order.items[0]).toMatchObject({
      cloverLineItemId: "line-1",
      providerLineItemId: "line-1",
      itemKey: "line-1",
      modifiers: ["Jalapeno", "Bacon"]
    });
    expect(buildSearchText(order)).toContain("loaded fries");
  });

  it("uses Clover order title as the customer-facing order label when displayCode is absent", () => {
    const order = normalizeOrder(
      {
        id: "ORDER789",
        title: "54",
        clientCreatedTime: 1_700_000_000_000,
        modifiedTime: 1_700_000_120_000,
        lineItems: []
      },
      "MERCHANT-1"
    );

    expect(order.orderLabel).toBe("#54");
  });

  it("converts Clover unitQty (milliunits, 1000 = 1 unit) to display quantity", () => {
    const order = normalizeOrder(
      {
        id: "ORDER-QTY",
        lineItems: {
          elements: [
            { id: "l1", name: "Frappuccino" }, // unitQty omitted → defaults to 1000 = 1 unit
            { id: "l2", name: "Frappuccino", unitQty: 1000 }, // explicit 1 unit
            { id: "l3", name: "Bag of beans", unitQty: 2000 }, // 2 units
            { id: "l4", name: "Coffee by weight", unitQty: 1500 } // 1.5 → rounds to 2
          ]
        }
      },
      "MERCHANT-1"
    );

    expect(order.items.map((i) => i.quantity)).toEqual([1, 1, 2, 2]);
  });

  it("normalizes Clover line item modifications as kitchen modifiers", () => {
    const order = normalizeOrder(
      {
        id: "ORDER123456",
        lineItems: {
          elements: [
            {
              id: "line-1",
              name: "Vanilla Rolled Ice Cream",
              modifications: {
                elements: [
                  { name: "Strawberry" },
                  { modifier: { name: "Cheese cake mix-in" } },
                  { modifier: { name: "strawberry topping" } }
                ]
              }
            }
          ]
        }
      },
      "MERCHANT-1"
    );

    expect(order.items[0]?.modifiers).toEqual([
      "Strawberry",
      "Cheese cake mix-in",
      "strawberry topping"
    ]);
  });

  it("builds stable item keys when a provider line item id is missing", () => {
    expect(
      buildStableItemKey(
        {
          providerLineItemId: null,
          cloverLineItemId: null,
          itemId: "catalog-1",
          name: "Loaded Fries",
          note: null,
          modifiers: []
        },
        2
      )
    ).toBe("catalog-1:2");

    expect(
      buildStableItemKey(
        {
          providerLineItemId: null,
          cloverLineItemId: null,
          itemId: null,
          name: "Loaded Fries",
          note: "Extra crisp",
          modifiers: ["No salt", "Extra bacon"]
        },
        1
      )
    ).toBe("loaded fries|extra crisp|no salt|extra bacon:1");
  });

  it("captures line priceCents and order amounts (the loyalty accrual basis — Phase 4b-1)", () => {
    const order = normalizeOrder(
      {
        id: "ORDER-MONEY",
        total: 1320, // grand total in cents (incl. tax)
        currency: "USD",
        lineItems: {
          elements: [
            { id: "l1", name: "Regular Rolled Ice Cream", price: 800 },
            { id: "l2", name: "Boba add-on", price: 400 }
          ]
        }
      },
      "MERCHANT-1"
    );

    expect(order.items.map((i) => i.priceCents)).toEqual([800, 400]);
    expect(order.amounts).toMatchObject({
      subtotalCents: 1200, // summed from line prices
      totalCents: 1320, // from Clover
      taxCents: 120, // total − subtotal (soft estimate)
      tipCents: null,
      currency: "USD"
    });
  });

  it("leaves priceCents null and amounts soft when the provider omits prices", () => {
    const order = normalizeOrder(
      { id: "ORDER-NOPRICE", lineItems: { elements: [{ id: "l1", name: "Mystery item" }] } },
      "MERCHANT-1"
    );

    expect(order.items[0]?.priceCents).toBeNull();
    expect(order.amounts).toMatchObject({ subtotalCents: null, totalCents: null, taxCents: null });
  });

  it("extracts the attached customer + phone (the loyalty accrual key — PR4a)", () => {
    const order = normalizeOrder(
      {
        id: "ORDER-CUST",
        lineItems: { elements: [{ id: "l1", name: "Rolled Ice Cream", price: 800 }] },
        // Shape from `expand=customers.phoneNumbers` (recipe doc §6).
        customers: {
          elements: [
            {
              id: "CUST1",
              firstName: "Jordan",
              phoneNumbers: { elements: [{ phoneNumber: "+19015551234" }] }
            }
          ]
        }
      },
      "MERCHANT-1"
    );

    expect(order.customer).toEqual({ phone: "+19015551234", name: "Jordan" });
  });

  it("leaves customer null for an anonymous (in-store) order", () => {
    const order = normalizeOrder(
      { id: "ORDER-ANON", lineItems: { elements: [{ id: "l1", name: "Roll" }] } },
      "MERCHANT-1"
    );

    expect(order.customer).toBeNull();
  });

  it("treats a customer with no phone and no name as anonymous (the plain expand=customers gotcha)", () => {
    const order = normalizeOrder(
      {
        id: "ORDER-EMPTY-CUST",
        lineItems: { elements: [{ id: "l1", name: "Roll" }] },
        // plain `expand=customers` returns phoneNumbers: [] — no usable accrual key.
        customers: { elements: [{ id: "CUST2", phoneNumbers: { elements: [] } }] }
      },
      "MERCHANT-1"
    );

    expect(order.customer).toBeNull();
  });
});
