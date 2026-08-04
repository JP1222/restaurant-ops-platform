import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startInventoryItContext, type InventoryItContext } from "./fixture.js";

// The effective-dated cost-history trigger (ADR-0573) is raw SQL, so it only fires
// against real Postgres: AFTER INSERT OR UPDATE OF cost_cents on inventory_items it
// appends to inventory_item_cost_history. The valuation logic that reads this history
// is unit-tested in tests/actual-cogs-store.test.ts; here we prove the trigger writes
// it correctly.
describe("inventory item cost-history trigger (real Postgres)", () => {
  let ctx: InventoryItContext;

  beforeAll(async () => {
    ctx = await startInventoryItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  // Ordered by the identity id (monotonic insert order) so two rows sharing a
  // millisecond effective_from still compare deterministically.
  async function costsFor(itemId: string): Promise<number[]> {
    const rows = await ctx.prisma.inventoryItemCostHistory.findMany({
      where: { itemId },
      orderBy: { id: "asc" },
      select: { costCents: true }
    });
    return rows.map((row) => row.costCents);
  }

  it("seeded items get a baseline cost-history row from the insert trigger", async () => {
    const item = await ctx.prisma.inventoryItem.findFirst({ select: { id: true, costCents: true } });
    expect(item).toBeTruthy();
    const costs = await costsFor(item!.id);
    expect(costs.length).toBeGreaterThanOrEqual(1);
    expect(costs.at(-1)).toBeCloseTo(item!.costCents, 6);
  });

  it("appends on a cost change but not on a non-cost or no-op edit", async () => {
    const category = await ctx.prisma.inventoryCategory.findFirst({ select: { id: true } });
    expect(category).toBeTruthy();
    const id = `it-cost-hist-${Date.now()}`;

    await ctx.prisma.inventoryItem.create({
      data: {
        id,
        sku: id,
        name: "Trigger probe",
        categoryId: category!.id,
        unit: "ea",
        onHand: 0,
        parMin: 0,
        parMax: 0,
        costCents: 500,
        vendor: "",
        shelfDays: 999,
        purchaseUnit: "",
        packQty: 1,
        purchaseCostCents: 500,
        lastCounted: "2026-06-06",
        flagged86: false
      }
    });
    expect(await costsFor(id)).toEqual([500]);

    // Cost change -> a second row.
    await ctx.prisma.inventoryItem.update({ where: { id }, data: { costCents: 800 } });
    expect(await costsFor(id)).toEqual([500, 800]);

    // Non-cost edit -> the trigger (OF cost_cents) does not fire, no new row.
    await ctx.prisma.inventoryItem.update({ where: { id }, data: { name: "Renamed" } });
    expect(await costsFor(id)).toEqual([500, 800]);

    // Same-cost write -> trigger fires but IS DISTINCT FROM is false, no new row.
    await ctx.prisma.inventoryItem.update({ where: { id }, data: { costCents: 800 } });
    expect(await costsFor(id)).toEqual([500, 800]);
  });
});
