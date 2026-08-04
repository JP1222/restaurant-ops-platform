import type { InventoryItem, InventoryItemState } from "@rop/db-inventory";
import { describe, expect, it } from "vitest";

import { toItem } from "../src/lib/serialize.js";

// Brand catalog row (one per item, shared across stores).
const itemRow: InventoryItem = {
  id: "ITEM-1",
  sku: "SKU-1",
  name: "Carnitas",
  categoryId: "food",
  unit: "lb",
  onHand: 10,
  parMin: 5,
  parMax: 20,
  costCents: 800,
  vendor: "Acme",
  shelfDays: 3,
  lastCounted: "2026-05-19",
  flagged86: false,
  icon: "",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-01T00:00:00.000Z")
};

describe("toItem catalog/state merge (Phase 4 part 3)", () => {
  it("falls back to the item's own columns when no state row is supplied", () => {
    // Single-store reads (and a location with no state row yet) emit the
    // pre-split shape unchanged.
    expect(toItem(itemRow)).toMatchObject({
      on_hand: 10,
      par_min: 5,
      par_max: 20,
      last_counted: "2026-05-19",
      flagged_86: false
    });
  });

  it("overlays the per-location state but keeps brand catalog fields from the item", () => {
    const state: InventoryItemState = {
      locationId: "store-2",
      itemId: "ITEM-1",
      onHand: 3,
      parMin: 8,
      parMax: 30,
      lastCounted: "2026-05-30",
      flagged86: true,
      createdAt: new Date("2026-05-30T00:00:00.000Z"),
      updatedAt: new Date("2026-05-30T00:00:00.000Z")
    };

    const dto = toItem(itemRow, state);

    // Per-location state wins for the live stock fields...
    expect(dto).toMatchObject({
      on_hand: 3,
      par_min: 8,
      par_max: 30,
      last_counted: "2026-05-30",
      flagged_86: true
    });
    // ...while brand catalog fields still come from the shared item row.
    expect(dto).toMatchObject({
      name: "Carnitas",
      sku: "SKU-1",
      unit: "lb",
      cost_cents: 800,
      vendor: "Acme"
    });
  });

  it("omits the icon when unset and emits it when chosen", () => {
    // The column defaults to "" for items with no chosen emoji, so the DTO stays
    // lean (no `icon` key) and the UI falls back to its category glyph.
    expect(toItem(itemRow)).not.toHaveProperty("icon");
    // A chosen emoji rides inline in the DTO (unlike the photo, which is a flag).
    expect(toItem({ ...itemRow, icon: "🍤" })).toMatchObject({ icon: "🍤" });
  });
});
