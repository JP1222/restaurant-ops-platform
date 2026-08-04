import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedOrder } from "@rop/contracts";
import { syncNormalizedOrder } from "../src/lib/sync-order.js";
import { kdsOrderBoardRemovedTotal } from "../src/lib/metrics.js";
import type { AppServices } from "../src/lib/services.js";

// GH #461: the unpaid-skip / reset-cutoff paths delete an order's board ticket.
// The delete is intended, but it used to be a silent deleteMany — so a paid
// order misclassified as unpaid would vanish from the kitchen with no trail.
// These tests lock in the metric + structured log, and that they fire ONLY when
// a ticket was actually on the board (count > 0).

const UNPAID_ORDER = {
  provider: "clover",
  merchantId: "merchant-1",
  sourceOrderId: "ord-1",
  paymentState: "OPEN",
  createdAt: "2026-06-16T12:00:00.000Z"
} as unknown as NormalizedOrder;

// Build a services stub whose $transaction yields a tx returning `deletedCount`
// kdsTickets, mirroring Prisma's deleteMany({ count }) result.
function servicesWith(deletedCount: number): AppServices {
  const tx = {
    kdsTicket: { deleteMany: vi.fn(async () => ({ count: deletedCount })) },
    cloverOrder: { deleteMany: vi.fn(async () => ({ count: deletedCount })) }
  };
  return {
    prisma: {
      $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx))
    }
  } as unknown as AppServices;
}

async function readMetric(reason: string): Promise<number> {
  const metric = kdsOrderBoardRemovedTotal as unknown as {
    get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
  };
  const snapshot = await metric.get();
  const row = snapshot.values.find(
    (v) => v.labels.provider === "clover" && v.labels.reason === reason
  );
  return row?.value ?? 0;
}

describe("syncNormalizedOrder unpaid-skip observability (GH #461)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a metric + structured warn when an existing board ticket is removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await readMetric("unpaid");

    const result = await syncNormalizedOrder(
      servicesWith(1),
      UNPAID_ORDER,
      {},
      "webhook",
      "Clover sync"
    );

    expect(result).toBeNull();
    expect(await readMetric("unpaid")).toBe(before + 1);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warn.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      scope: "kds.sync",
      event: "order_pulled_from_board",
      reason: "unpaid",
      provider: "clover",
      merchantId: "merchant-1",
      paymentState: "OPEN",
      removedTickets: 1
    });
  });

  it("stays quiet when the unpaid order was never on the board (count 0)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await readMetric("unpaid");

    const result = await syncNormalizedOrder(
      servicesWith(0),
      UNPAID_ORDER,
      {},
      "webhook",
      "Clover sync"
    );

    expect(result).toBeNull();
    expect(await readMetric("unpaid")).toBe(before); // unchanged
    expect(warn).not.toHaveBeenCalled();
  });
});
