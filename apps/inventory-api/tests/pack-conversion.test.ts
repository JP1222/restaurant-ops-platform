import { describe, expect, it } from "vitest";

import type {
  InventoryBarcode as BarcodeRow,
  InventoryItemPack as PackRow,
  PrismaClient
} from "@rop/db-inventory";

import { PackNotFoundError, resolvePackConversion } from "../src/lib/inventory-store.js";
import { toBarcode, toItemPack } from "../src/lib/serialize.js";

// A 24-each case pack on item-1 (ADR-0737).
const pack: PackRow = {
  id: "pack-1",
  itemId: "item-1",
  label: "Case",
  baseQtyPerPack: 24,
  vendor: "",
  containsLabel: "",
  containsQty: null,
  isPurchaseDefault: true,
  sort: 0,
  createdAt: new Date("2026-06-17T00:00:00.000Z"),
  updatedAt: new Date("2026-06-17T00:00:00.000Z")
};

// Minimal tx stub: only inventoryItemPack.findUnique is reached by resolvePackConversion.
function txWith(found: PackRow | null): Pick<PrismaClient, "inventoryItemPack"> {
  return {
    inventoryItemPack: { findUnique: async () => found }
  } as unknown as Pick<PrismaClient, "inventoryItemPack">;
}

describe("resolvePackConversion (ADR-0737)", () => {
  it("passes through unchanged when no pack_id (qty is base units)", async () => {
    const r = await resolvePackConversion(txWith(null), "item-1", undefined, 2, 5000);
    expect(r).toEqual({ qty: 2, unitCostCents: 5000 });
  });

  it("multiplies qty and divides per-pack cost by base_qty_per_pack", async () => {
    const r = await resolvePackConversion(txWith(pack), "item-1", "pack-1", 2, 5000);
    expect(r.qty).toBe(48);
    // 5000 / 24, rounded to 4 decimals of a cent (roundCost).
    expect(r.unitCostCents).toBeCloseTo(208.3333, 3);
  });

  it("leaves an absent cost absent", async () => {
    const r = await resolvePackConversion(txWith(pack), "item-1", "pack-1", 3);
    expect(r).toEqual({ qty: 72, unitCostCents: undefined });
  });

  it("throws PackNotFoundError when the pack id is unknown", async () => {
    await expect(resolvePackConversion(txWith(null), "item-1", "pack-1", 1)).rejects.toBeInstanceOf(
      PackNotFoundError
    );
  });

  it("throws when the pack belongs to a different item (never cross-convert)", async () => {
    const foreign: PackRow = { ...pack, itemId: "item-2" };
    await expect(
      resolvePackConversion(txWith(foreign), "item-1", "pack-1", 1)
    ).rejects.toBeInstanceOf(PackNotFoundError);
  });
});

describe("pack/barcode serializers (ADR-0737)", () => {
  it("toItemPack maps DB columns to the snake_case DTO", () => {
    expect(toItemPack(pack)).toEqual({
      id: "pack-1",
      label: "Case",
      base_qty_per_pack: 24,
      vendor: "",
      contains_label: "",
      contains_qty: null,
      is_purchase_default: true,
      sort: 0
    });
  });

  it("toBarcode maps DB columns to the DTO", () => {
    const row: BarcodeRow = {
      code: "0123456789012",
      itemId: "item-1",
      packId: "pack-1",
      source: "manufacturer",
      label: "",
      createdAt: new Date("2026-06-17T00:00:00.000Z"),
      updatedAt: new Date("2026-06-17T00:00:00.000Z")
    };
    expect(toBarcode(row)).toEqual({
      code: "0123456789012",
      pack_id: "pack-1",
      source: "manufacturer",
      label: ""
    });
  });
});
