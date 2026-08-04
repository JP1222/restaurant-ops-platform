import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rop/db-inventory";
import { getDataset } from "../src/lib/inventory-store.js";

// GH #184: the `activity` feed is an append-only ledger the UI only ever shows a
// slice(0,5) of, so GET /api/inventory must not re-read + re-validate the whole
// ever-growing table. This pins the bound to ACTIVITY ONLY — counts and waste are
// read in FULL because the backoffice computes whole-history aggregates + an "all
// recorded events" CSV over them, so capping those would silently corrupt totals
// (the regression an adversarial review caught before merge).
//
// We only need the reads to fire — they happen inside the Promise.all BEFORE
// assembleDataset runs — so we don't construct a contract-valid dataset; the
// (possible) downstream assembly rejection is swallowed.

function fm() {
  return vi.fn(async () => [] as unknown[]);
}
function fu() {
  return vi.fn(async () => null);
}

function mockPrisma() {
  return {
    inventoryCategory: { findMany: fm() },
    inventoryItem: { findMany: fm() },
    inventoryItemState: { findMany: fm() },
    inventoryItemImage: { findMany: fm() },
    inventoryRecipe: { findMany: fm() },
    inventoryVendor: { findMany: fm() },
    inventoryVendorQuote: { findMany: fm() },
    inventoryItemAlias: { findMany: fm() },
    inventoryPurchaseOrder: { findMany: fm() },
    inventoryCountRecord: { findMany: fm() },
    inventoryWasteReason: { findMany: fm() },
    inventoryWasteEntry: { findMany: fm() },
    inventoryActivityEntry: { findMany: fm() },
    inventoryWasteSettings: { findUnique: fu() },
    inventoryMetrics: { findUnique: fu() }
  };
}

describe("getDataset bounds only the activity feed (GH #184)", () => {
  it("caps the activity read with a take", async () => {
    const prisma = mockPrisma();

    await getDataset(prisma as unknown as PrismaClient).catch(() => undefined);

    expect(prisma.inventoryActivityEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.inventoryActivityEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: expect.any(Number) })
    );
  });

  it("reads counts + waste in FULL (no take) so whole-history aggregates/CSV stay correct", async () => {
    const prisma = mockPrisma();

    await getDataset(prisma as unknown as PrismaClient).catch(() => undefined);

    // Capping these would silently truncate the backoffice waste KPIs, the
    // top-offender SKU rollup, the count-variance history, and the "all recorded
    // events" CSV export once a ledger exceeds the cap.
    for (const model of [prisma.inventoryCountRecord, prisma.inventoryWasteEntry]) {
      expect(model.findMany).toHaveBeenCalledTimes(1);
      expect(model.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ take: expect.anything() })
      );
    }
  });

  it("does NOT cap the brand-level item read (no take)", async () => {
    const prisma = mockPrisma();

    await getDataset(prisma as unknown as PrismaClient).catch(() => undefined);

    expect(prisma.inventoryItem.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() })
    );
  });
});
