import type { ActualCogsWindow } from "@rop/contracts";
import type { PrismaClient } from "@rop/db-inventory";

import { DEFAULT_LOCATION_ID } from "./inventory-store.js";

// Cap on how many of the most recent between-count windows to compute, so a long
// count history doesn't fan out into an unbounded number of aggregate queries.
const MAX_WINDOWS = 12;

async function loadItemCostCents(prisma: PrismaClient): Promise<Map<string, number>> {
  const items = await prisma.inventoryItem.findMany({ select: { id: true, costCents: true } });
  return new Map(items.map((item) => [item.id, item.costCents]));
}

interface CostPoint {
  effectiveFrom: Date;
  costCents: number;
}

// Effective-dated per-usage cost history (ADR-0573 follow-up), item -> points sorted
// ascending by effective_from. Lets each count be valued at the cost effective THEN,
// so a later edit can't re-price a closed window.
async function loadCostHistory(prisma: PrismaClient): Promise<Map<string, CostPoint[]>> {
  const rows = await prisma.inventoryItemCostHistory.findMany({
    select: { itemId: true, costCents: true, effectiveFrom: true },
    orderBy: [{ itemId: "asc" }, { effectiveFrom: "asc" }]
  });
  const byItem = new Map<string, CostPoint[]>();
  for (const row of rows) {
    const point: CostPoint = { effectiveFrom: row.effectiveFrom, costCents: row.costCents };
    const list = byItem.get(row.itemId);
    if (list) list.push(point);
    else byItem.set(row.itemId, [point]);
  }
  return byItem;
}

// Per-usage cost effective at `at`: the latest history row with effective_from <= at.
// Falls back to the item's CURRENT cost when no dated cost precedes `at` (e.g. history
// that predates this feature), preserving the prior current-cost behavior rather than
// guessing 0. Unknown item (no history, no current cost) -> 0, never a guess.
function costAt(
  itemId: string,
  at: Date,
  history: Map<string, CostPoint[]>,
  currentCost: Map<string, number>
): number {
  const points = history.get(itemId);
  if (points) {
    let resolved: number | null = null;
    for (const point of points) {
      if (point.effectiveFrom.getTime() <= at.getTime()) resolved = point.costCents;
      else break; // ascending: every later point is in the future of `at`
    }
    if (resolved != null) return resolved;
  }
  return currentCost.get(itemId) ?? 0;
}

// On-hand inventory value (cents) as of `at`, reconstructed from the append-only stock
// ledger: on_hand per item = Σ delta with created_at <= at, valued at the cost effective
// at `at`. Items with no known cost value at 0 (cost unknown, never guessed).
async function inventoryValueAt(
  prisma: PrismaClient,
  locationId: string,
  at: Date,
  history: Map<string, CostPoint[]>,
  currentCost: Map<string, number>
): Promise<number> {
  const rows = await prisma.inventoryStockMovement.groupBy({
    by: ["itemId"],
    where: { locationId, createdAt: { lte: at } },
    _sum: { delta: true }
  });
  let cents = 0;
  for (const row of rows) {
    const onHand = row._sum.delta ?? 0;
    cents += onHand * costAt(row.itemId, at, history, currentCost);
  }
  return cents;
}

// Value (cents) of stock received in (after, until], valued at the cost effective at the
// window's closing count (`until`) — the same basis as that window's ending inventory, so
// the window stays internally consistent and immutable once its closing count is taken.
async function receivedValueBetween(
  prisma: PrismaClient,
  locationId: string,
  after: Date,
  until: Date,
  history: Map<string, CostPoint[]>,
  currentCost: Map<string, number>
): Promise<number> {
  const rows = await prisma.inventoryStockMovement.groupBy({
    by: ["itemId"],
    where: { locationId, reason: "receive", createdAt: { gt: after, lte: until } },
    _sum: { delta: true }
  });
  let cents = 0;
  for (const row of rows) {
    const qty = row._sum.delta ?? 0;
    cents += qty * costAt(row.itemId, until, history, currentCost);
  }
  return cents;
}

// Count-based actual COGS per between-count window for analytics' yield-variance ingest
// (ADR-0031). Each closed physical count bounds a window; actual COGS = beginning +
// received − ending, each count valued at the per-usage cost effective at that count
// (ADR-0573 effective-dated cost history), so a later cost edit can't re-price a closed
// window. Two counts are the minimum to form one window, so < 2 yields []. Stamped
// with the store's Clover merchant id (the analytics join key); [] when none is
// configured, exactly like listLaborCostSnapshots — nothing maps to the mart, so nothing
// is ingested under a guessed key.
export async function listActualCogsWindows(
  prisma: PrismaClient,
  merchantId: string | undefined,
  locationId: string = DEFAULT_LOCATION_ID
): Promise<ActualCogsWindow[]> {
  if (!merchantId) {
    return [];
  }

  const counts = await prisma.inventoryCountRecord.findMany({
    where: { locationId, status: "closed" },
    orderBy: { createdAt: "asc" },
    select: { date: true, createdAt: true }
  });
  if (counts.length < 2) {
    return [];
  }

  // Most recent MAX_WINDOWS + 1 counts -> at most MAX_WINDOWS windows.
  const bounded = counts.slice(Math.max(0, counts.length - (MAX_WINDOWS + 1)));
  const [currentCost, history] = await Promise.all([
    loadItemCostCents(prisma),
    loadCostHistory(prisma)
  ]);

  const valued: { date: string; at: Date; value: number }[] = [];
  for (const count of bounded) {
    valued.push({
      date: count.date,
      at: count.createdAt,
      value: await inventoryValueAt(prisma, locationId, count.createdAt, history, currentCost)
    });
  }

  const windows: ActualCogsWindow[] = [];
  for (let i = 1; i < valued.length; i++) {
    const prev = valued[i - 1];
    const cur = valued[i];
    if (!prev || !cur) {
      continue;
    }
    const received = await receivedValueBetween(prisma, locationId, prev.at, cur.at, history, currentCost);
    windows.push({
      merchant_id: merchantId,
      period_start: prev.date,
      period_end: cur.date,
      beginning_value_cents: Math.round(prev.value),
      received_value_cents: Math.round(received),
      ending_value_cents: Math.round(cur.value),
      actual_cogs_cents: Math.round(prev.value + received - cur.value)
    });
  }
  return windows;
}
