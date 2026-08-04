import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@rop/db-inventory";

import { listActualCogsWindows } from "../src/lib/actual-cogs-store.js";

function countRow(date: string) {
  return { date, createdAt: new Date(`${date}T12:00:00Z`) };
}

// Empty effective-dated cost history -> the valuation falls back to the item's
// current cost, i.e. the pre-ADR-0573 behavior the first cases below pin.
function noCostHistory() {
  return { findMany: vi.fn().mockResolvedValue([]) };
}

describe("listActualCogsWindows", () => {
  it("returns [] and skips the DB when no merchant is configured", async () => {
    const findMany = vi.fn();
    const prisma = {
      inventoryCountRecord: { findMany },
      inventoryItem: { findMany: vi.fn() },
      inventoryItemCostHistory: noCostHistory(),
      inventoryStockMovement: { groupBy: vi.fn() }
    } as unknown as PrismaClient;

    expect(await listActualCogsWindows(prisma, undefined)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns [] when fewer than two counts bound no window", async () => {
    const prisma = {
      inventoryCountRecord: { findMany: vi.fn().mockResolvedValue([countRow("2026-06-01")]) },
      inventoryItem: { findMany: vi.fn() },
      inventoryItemCostHistory: noCostHistory(),
      inventoryStockMovement: { groupBy: vi.fn() }
    } as unknown as PrismaClient;

    expect(await listActualCogsWindows(prisma, "M1")).toEqual([]);
  });

  it("computes beginning + received − ending per between-count window (current-cost fallback)", async () => {
    const groupBy = vi
      .fn()
      // inventory value at the first count: 100*50 + 50*20 = 6000
      .mockResolvedValueOnce([
        { itemId: "a", _sum: { delta: 100 } },
        { itemId: "b", _sum: { delta: 50 } }
      ])
      // inventory value at the second count: 80*50 + 40*20 = 4800
      .mockResolvedValueOnce([
        { itemId: "a", _sum: { delta: 80 } },
        { itemId: "b", _sum: { delta: 40 } }
      ])
      // received in the window: 30*50 = 1500
      .mockResolvedValueOnce([{ itemId: "a", _sum: { delta: 30 } }]);

    const prisma = {
      inventoryCountRecord: {
        findMany: vi.fn().mockResolvedValue([countRow("2026-06-01"), countRow("2026-06-08")])
      },
      inventoryItem: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a", costCents: 50 },
          { id: "b", costCents: 20 }
        ])
      },
      inventoryItemCostHistory: noCostHistory(),
      inventoryStockMovement: { groupBy }
    } as unknown as PrismaClient;

    const out = await listActualCogsWindows(prisma, "M1");

    expect(out).toEqual([
      {
        merchant_id: "M1",
        period_start: "2026-06-01",
        period_end: "2026-06-08",
        beginning_value_cents: 6000,
        received_value_cents: 1500,
        ending_value_cents: 4800,
        actual_cogs_cents: 2700
      }
    ]);
    // The received query is scoped to reason='receive' in the (prev, cur] interval.
    expect(groupBy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ reason: "receive" })
      })
    );
  });

  it("values each count at the cost effective then, so a later edit can't re-price a closed window", async () => {
    // Item 'a': 50c from 2026-05-01, raised to 80c effective 2026-06-05 (mid-window),
    // then edited to 999c on 2026-07-01 — AFTER the window closed. The 999c current cost
    // must never enter a window whose counts predate it.
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([{ itemId: "a", _sum: { delta: 100 } }]) // begin 2026-06-01
      .mockResolvedValueOnce([{ itemId: "a", _sum: { delta: 80 } }]) // end 2026-06-08
      .mockResolvedValueOnce([]); // no receives in the window

    const prisma = {
      inventoryCountRecord: {
        findMany: vi.fn().mockResolvedValue([countRow("2026-06-01"), countRow("2026-06-08")])
      },
      // Current cost is the post-window 999c edit.
      inventoryItem: { findMany: vi.fn().mockResolvedValue([{ id: "a", costCents: 999 }]) },
      inventoryItemCostHistory: {
        findMany: vi.fn().mockResolvedValue([
          { itemId: "a", costCents: 50, effectiveFrom: new Date("2026-05-01T00:00:00Z") },
          { itemId: "a", costCents: 80, effectiveFrom: new Date("2026-06-05T00:00:00Z") },
          { itemId: "a", costCents: 999, effectiveFrom: new Date("2026-07-01T00:00:00Z") }
        ])
      },
      inventoryStockMovement: { groupBy }
    } as unknown as PrismaClient;

    const out = await listActualCogsWindows(prisma, "M1");

    expect(out[0]).toMatchObject({
      // begin count 2026-06-01 -> 50c effective -> 100*50 = 5000
      beginning_value_cents: 5000,
      received_value_cents: 0,
      // end count 2026-06-08 -> 80c effective (the 999c edit is later) -> 80*80 = 6400
      ending_value_cents: 6400,
      // 5000 + 0 − 6400 — the mid-window price rise, NOT the later 999c edit
      actual_cogs_cents: -1400
    });
  });

  it("values an item at 0 when its cost is unknown rather than guessing", async () => {
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([{ itemId: "ghost", _sum: { delta: 100 } }])
      .mockResolvedValueOnce([{ itemId: "ghost", _sum: { delta: 40 } }])
      .mockResolvedValueOnce([]);

    const prisma = {
      inventoryCountRecord: {
        findMany: vi.fn().mockResolvedValue([countRow("2026-06-01"), countRow("2026-06-08")])
      },
      inventoryItem: { findMany: vi.fn().mockResolvedValue([]) },
      inventoryItemCostHistory: noCostHistory(),
      inventoryStockMovement: { groupBy }
    } as unknown as PrismaClient;

    const out = await listActualCogsWindows(prisma, "M1");
    expect(out[0]).toMatchObject({
      beginning_value_cents: 0,
      received_value_cents: 0,
      ending_value_cents: 0,
      actual_cogs_cents: 0
    });
  });
});
