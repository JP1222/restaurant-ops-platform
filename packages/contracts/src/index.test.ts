import { describe, expect, it } from "vitest";

import {
  InventoryDatasetSchema,
  KdsTicketItemSchema,
  KdsTicketSchema,
  NormalizedOrderItemSchema,
  NormalizedOrderSchema,
} from "./index.js";

function baseTicket() {
  return {
    id: "tkt_1",
    merchantId: "M1",
    provider: "clover" as const,
    cloverOrderId: "ORD1",
    sourceOrderId: "ORD1",
    orderLabel: "#42",
    status: "new" as const,
    source: null,
    orderType: null,
    paymentState: null,
    note: null,
    lastActor: null,
    heldAt: null,
    holdUntil: null,
    displayChannelLabel: null,
    displayFulfillmentTimeLabel: null,
    createdAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:00:00.000Z",
    elapsedMinutes: 0,
    items: [] as unknown[],
  };
}

describe("KdsTicketSchema", () => {
  it("accepts a ticket with an empty items array and applies field defaults", () => {
    const parsed = KdsTicketSchema.parse(baseTicket());
    expect(parsed.items).toEqual([]);
    expect(parsed.priority).toBe(0); // default
    expect(parsed.hasLocalEdits).toBe(false); // default
  });

  it("accepts a ticket with populated items and applies item-level defaults", () => {
    const parsed = KdsTicketSchema.parse({
      ...baseTicket(),
      items: [
        {
          id: "li_1",
          cloverLineItemId: null,
          providerLineItemId: null,
          itemKey: "roll-strawberry",
          itemId: null,
          name: "Strawberry Roll",
          alternateName: null,
          note: null,
          quantity: 2,
        },
      ],
    });
    const item = parsed.items.at(0);
    if (!item) throw new Error("expected one ticket item");
    expect(item.quantity).toBe(2);
    expect(item.modifiers).toEqual([]); // default
    expect(item.refunded).toBe(false); // default
    expect(item.printed).toBe(false); // default
    expect(item.completed).toBe(false); // KdsTicketItemCompletionSchema default
    expect(item.completedAt).toBeNull();
  });

  it("rejects a line item with quantity below 1", () => {
    expect(
      KdsTicketItemSchema.safeParse({
        id: "li_1",
        cloverLineItemId: null,
        providerLineItemId: null,
        itemKey: "k",
        itemId: null,
        name: "X",
        alternateName: null,
        note: null,
        quantity: 0,
      }).success,
    ).toBe(false);
  });
});

describe("NormalizedOrderSchema", () => {
  function baseOrder() {
    return {
      provider: "clover" as const,
      merchantId: "M1",
      orderId: "ORD1",
      sourceOrderId: "ORD1",
      orderLabel: "#42",
      source: null,
      orderType: null,
      paymentState: null,
      note: null,
      createdAt: "2026-05-31T12:00:00.000Z",
      modifiedAt: "2026-05-31T12:00:00.000Z",
      items: [
        {
          cloverLineItemId: null,
          providerLineItemId: null,
          itemKey: "roll",
          itemId: null,
          name: "Roll",
          alternateName: null,
          note: null,
          quantity: 1,
        },
      ],
    };
  }

  it("defaults the per-line refund flag to false and price to null", () => {
    const parsed = NormalizedOrderItemSchema.parse({
      cloverLineItemId: null,
      providerLineItemId: null,
      itemKey: "roll",
      itemId: null,
      name: "Roll",
      alternateName: null,
      note: null,
      quantity: 1,
    });
    expect(parsed.refunded).toBe(false);
    expect(parsed.priceCents).toBeNull();
  });

  it("preserves an explicit refunded line flag through the order schema", () => {
    const parsed = NormalizedOrderSchema.parse({
      ...baseOrder(),
      items: [{ ...baseOrder().items[0], refunded: true, priceCents: 899 }],
    });
    const line = parsed.items.at(0);
    if (!line) throw new Error("expected one order line");
    expect(line.refunded).toBe(true);
    expect(line.priceCents).toBe(899);
  });

  it("defaults order-level amounts and customer to null for an anonymous order", () => {
    const parsed = NormalizedOrderSchema.parse(baseOrder());
    expect(parsed.amounts).toBeNull();
    expect(parsed.customer).toBeNull();
    expect(parsed.priority).toBe(0); // default
  });
});

describe("InventoryDatasetSchema", () => {
  function emptyDataset() {
    return {
      categories: [],
      items: [],
      recipes: [],
      activity: [],
      pos: [],
      counts: [],
      cogs_target_pct: 0.3,
      vendors: [],
      vendor_quotes: [],
      waste_reasons: [],
      waste_log: [],
      waste_settings: { photo_required_over_cents: 500, manager_approval_over_cents: 2000 },
    };
  }

  it("accepts a dataset with all collections empty", () => {
    const parsed = InventoryDatasetSchema.parse(emptyDataset());
    expect(parsed.items).toEqual([]);
    expect(parsed.cogs_target_pct).toBe(0.3);
  });

  it("rejects a category carrying an unknown category id enum", () => {
    const bad = {
      ...emptyDataset(),
      categories: [{ id: "not-a-real-category", name: "Bad", color: "#000" }],
    };
    expect(InventoryDatasetSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a known category id enum value", () => {
    const ok = {
      ...emptyDataset(),
      categories: [{ id: "food", name: "Protein", color: "#f00" }],
    };
    expect(InventoryDatasetSchema.safeParse(ok).success).toBe(true);
  });
});
