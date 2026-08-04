import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlateCostSnapshot } from "@rop/contracts";

import { startAnalyticsItContext, type AnalyticsItContext } from "./fixture.js";
import { ingestPlateCosts } from "../../src/inventory/ingest-plate-costs.js";

const snap = (id: string, cents: number, eff: string): PlateCostSnapshot => ({
  clover_item_id: id,
  plate_cost_cents: cents,
  currency: "USD",
  effective_from: eff,
});

async function countFor(ctx: AnalyticsItContext, id: string): Promise<number> {
  const r = await ctx.pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM mart.dim_item_cost WHERE clover_item_id = $1",
    [id],
  );
  return Number(r.rows[0]?.n);
}

describe("ingestPlateCosts (real Postgres)", () => {
  let ctx: AnalyticsItContext;

  beforeAll(async () => {
    ctx = await startAnalyticsItContext();
  });

  afterAll(async () => {
    await ctx?.stop();
  });

  it("upserts SCD-2-lite into mart.dim_item_cost", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_item_cost");

    // 1. first ingest -> both inserted
    expect(
      await ingestPlateCosts(ctx.pool, [snap("A", 100, "2026-06-02"), snap("B", 50, "2026-06-02")]),
    ).toEqual({ received: 2, written: 2 });

    // 2. re-ingest identical -> nothing written (no redundant effective rows)
    expect(
      (await ingestPlateCosts(ctx.pool, [snap("A", 100, "2026-06-02"), snap("B", 50, "2026-06-02")]))
        .written,
    ).toBe(0);

    // 3. A's cost changes on a NEW day -> a new effective-dated row for A only
    expect(
      (await ingestPlateCosts(ctx.pool, [snap("A", 120, "2026-06-03"), snap("B", 50, "2026-06-03")]))
        .written,
    ).toBe(1);
    expect(await countFor(ctx, "A")).toBe(2);
    expect(await countFor(ctx, "B")).toBe(1);

    // 4. SAME-day change -> updates that day's row, no new row
    expect((await ingestPlateCosts(ctx.pool, [snap("A", 130, "2026-06-03")])).written).toBe(1);
    expect(await countFor(ctx, "A")).toBe(2);

    // latest cost for A is the most recent value
    const latest = await ctx.pool.query<{ plate_cost_cents: string }>(
      `SELECT plate_cost_cents FROM mart.dim_item_cost
       WHERE clover_item_id = 'A' ORDER BY effective_from DESC LIMIT 1`,
    );
    expect(Number(latest.rows[0]?.plate_cost_cents)).toBe(130);
  });

  it("preserves sub-cent precision (numeric, not integer)", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_item_cost");
    await ingestPlateCosts(ctx.pool, [snap("C", 125.2, "2026-06-02")]);
    const r = await ctx.pool.query<{ plate_cost_cents: string }>(
      "SELECT plate_cost_cents FROM mart.dim_item_cost WHERE clover_item_id = 'C'",
    );
    expect(Number(r.rows[0]?.plate_cost_cents)).toBe(125.2);
  });

  // #474: a UTC-instant effective_from must be stored as the STORE-LOCAL date so
  // it lines up with business_date. A bare date (e.g. backfill) passes through.
  it("stores effective_from as the store-local date for a UTC instant", async () => {
    await ctx.pool.query("TRUNCATE mart.dim_item_cost");

    // 00:30 UTC on 06-03 is 19:30 on 06-02 in America/Chicago (CDT). The UTC
    // date (06-03) is a day ahead of the store-local date (06-02).
    await ingestPlateCosts(
      ctx.pool,
      [snap("D", 100, "2026-06-03T00:30:00.000Z")],
      "America/Chicago",
    );
    const utcInstant = await ctx.pool.query<{ effective_from: string }>(
      "SELECT effective_from::text FROM mart.dim_item_cost WHERE clover_item_id = 'D'",
    );
    expect(utcInstant.rows[0]?.effective_from).toBe("2026-06-02");

    // A bare calendar date is already store-local; it must NOT shift a day back.
    await ingestPlateCosts(ctx.pool, [snap("E", 100, "2026-06-02")], "America/Chicago");
    const bare = await ctx.pool.query<{ effective_from: string }>(
      "SELECT effective_from::text FROM mart.dim_item_cost WHERE clover_item_id = 'E'",
    );
    expect(bare.rows[0]?.effective_from).toBe("2026-06-02");
  });
});
