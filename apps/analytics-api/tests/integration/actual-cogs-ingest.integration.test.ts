import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActualCogsWindow } from "@rop/contracts";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { ingestActualCogs } from "../../src/inventory/ingest-actual-cogs.js";

const win = (
  merchant: string,
  start: string,
  end: string,
  actual: number
): ActualCogsWindow => ({
  merchant_id: merchant,
  period_start: start,
  period_end: end,
  beginning_value_cents: 10000,
  received_value_cents: 2000,
  ending_value_cents: 10000 + 2000 - actual,
  actual_cogs_cents: actual
});

async function countFor(ctx: AnalyticsItContext, merchant: string): Promise<number> {
  const r = await ctx.pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM mart.dim_actual_cogs WHERE merchant_id = $1",
    [merchant]
  );
  return Number(r.rows[0]?.n);
}

describe("ingestActualCogs (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("upserts windows into mart.dim_actual_cogs keyed by the two count dates", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_actual_cogs");

    expect(
      await ingestActualCogs(ctx.pool, [
        win("M1", "2026-06-01", "2026-06-08", 2700),
        win("M1", "2026-06-08", "2026-06-15", 3100)
      ])
    ).toEqual({ received: 2, written: 2 });
    expect(await countFor(ctx, "M1")).toBe(2);

    // re-ingest identical -> idempotent upsert, no new rows
    await ingestActualCogs(ctx.pool, [
      win("M1", "2026-06-01", "2026-06-08", 2700),
      win("M1", "2026-06-08", "2026-06-15", 3100)
    ]);
    expect(await countFor(ctx, "M1")).toBe(2);

    // same window key, corrected actual -> updates that row in place
    await ingestActualCogs(ctx.pool, [win("M1", "2026-06-08", "2026-06-15", 2950)]);
    expect(await countFor(ctx, "M1")).toBe(2);
    const updated = await ctx.pool.query<{ actual_cogs_cents: string }>(
      `SELECT actual_cogs_cents FROM mart.dim_actual_cogs
       WHERE merchant_id = 'M1' AND period_start = '2026-06-08' AND period_end = '2026-06-15'`
    );
    expect(Number(updated.rows[0]?.actual_cogs_cents)).toBe(2950);
  });

  it("preserves sub-cent precision (numeric, not integer)", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_actual_cogs");
    await ingestActualCogs(ctx.pool, [
      {
        merchant_id: "M2",
        period_start: "2026-06-01",
        period_end: "2026-06-08",
        beginning_value_cents: 100.5,
        received_value_cents: 0,
        ending_value_cents: 0,
        actual_cogs_cents: 100.5
      }
    ]);
    const r = await ctx.pool.query<{ actual_cogs_cents: string }>(
      "SELECT actual_cogs_cents FROM mart.dim_actual_cogs WHERE merchant_id = 'M2'"
    );
    expect(Number(r.rows[0]?.actual_cogs_cents)).toBeCloseTo(100.5, 2);
  });
});
