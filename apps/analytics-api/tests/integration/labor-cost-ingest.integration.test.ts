import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LaborCostSnapshot } from "@rop/contracts";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { ingestLaborCosts } from "../../src/inventory/ingest-labor-costs.js";

const snap = (merchant: string, cents: number, eff: string, note?: string): LaborCostSnapshot => ({
  merchant_id: merchant,
  daily_labor_cost_cents: cents,
  currency: "USD",
  effective_from: eff,
  note: note ?? null
});

async function countFor(ctx: AnalyticsItContext, merchant: string): Promise<number> {
  const r = await ctx.pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM mart.dim_labor_cost WHERE merchant_id = $1",
    [merchant]
  );
  return Number(r.rows[0]?.n);
}

describe("ingestLaborCosts (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("upserts effective-dated rows into mart.dim_labor_cost", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_labor_cost");

    // 1. first ingest -> both rows inserted
    expect(
      await ingestLaborCosts(ctx.pool, [snap("M1", 46666.67, "2026-06-01"), snap("M1", 50000, "2026-06-08")])
    ).toEqual({ received: 2, written: 2 });
    expect(await countFor(ctx, "M1")).toBe(2);

    // 2. re-ingest identical -> idempotent upsert, no new rows
    await ingestLaborCosts(ctx.pool, [snap("M1", 46666.67, "2026-06-01"), snap("M1", 50000, "2026-06-08")]);
    expect(await countFor(ctx, "M1")).toBe(2);

    // 3. same effective_from, new value -> updates that row in place
    await ingestLaborCosts(ctx.pool, [snap("M1", 55000, "2026-06-08")]);
    expect(await countFor(ctx, "M1")).toBe(2);
    const latest = await ctx.pool.query<{ daily_labor_cost_cents: string }>(
      `SELECT daily_labor_cost_cents FROM mart.dim_labor_cost
       WHERE merchant_id = 'M1' AND effective_from = '2026-06-08'`
    );
    expect(Number(latest.rows[0]?.daily_labor_cost_cents)).toBe(55000);
  });

  it("preserves sub-cent precision (numeric, not integer)", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_labor_cost");
    await ingestLaborCosts(ctx.pool, [snap("M2", 46666.666, "2026-06-01")]);
    const r = await ctx.pool.query<{ daily_labor_cost_cents: string }>(
      "SELECT daily_labor_cost_cents FROM mart.dim_labor_cost WHERE merchant_id = 'M2'"
    );
    expect(Number(r.rows[0]?.daily_labor_cost_cents)).toBeCloseTo(46666.666, 3);
  });

  // Same #474 fix as plate cost: a UTC-instant effective_from is stored as the
  // store-local date so it lines up with business_date; a bare date passes through.
  it("stores effective_from as the store-local date for a UTC instant", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_labor_cost");
    await ingestLaborCosts(ctx.pool, [snap("M3", 100, "2026-06-03T00:30:00.000Z")], "America/Chicago");
    const r = await ctx.pool.query<{ effective_from: string }>(
      "SELECT effective_from::text FROM mart.dim_labor_cost WHERE merchant_id = 'M3'"
    );
    expect(r.rows[0]?.effective_from).toBe("2026-06-02");
  });
});
