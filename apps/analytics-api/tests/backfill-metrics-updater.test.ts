import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import type { SyncTarget, SyncTargetsReader } from "../src/sync-targets/repository.js";
import { BackfillMetricsUpdater } from "../src/metrics/backfill-metrics-updater.js";
import { ensureBackfillGauges, resetBackfillGauges } from "../src/metrics/backfill-gauges.js";

const NOW = new Date("2026-03-15T00:00:00.000Z");

const config = {
  backfillStartDate: new Date("2026-01-01T00:00:00.000Z"),
  backfillWindowDays: 30,
  exportWindowStartUtc: "10:00",
  exportWindowEndUtc: "15:00",
  exportHistoricalBackfillWindowShare: 0.4,
  backfillMetricsRefreshSeconds: 300,
} as AppConfig;

// One completed window + one blocked window for the configured range.
const rows = [
  {
    window_start: new Date("2026-01-01T00:00:00.000Z"),
    window_end: new Date("2026-01-31T00:00:00.000Z"),
    status: "completed",
    retry_after: null,
    blocked_at: null,
    failure_count: 0,
    last_error: null,
    completed_at: new Date("2026-02-01T13:00:00.000Z"),
    updated_at: new Date("2026-02-01T13:00:00.000Z"),
  },
  {
    window_start: new Date("2026-01-31T00:00:00.000Z"),
    window_end: new Date("2026-03-02T00:00:00.000Z"),
    status: "blocked",
    retry_after: null,
    blocked_at: new Date("2026-03-03T13:00:00.000Z"),
    failure_count: 3,
    last_error: "Clover export failed with 403.",
    completed_at: null,
    updated_at: new Date("2026-03-03T13:00:00.000Z"),
  },
];

class MockPool {
  calls = 0;
  async query() {
    this.calls += 1;
    return { rows, rowCount: rows.length };
  }
}

function target(merchantId: string, active: boolean): SyncTarget {
  return { merchantId, provider: "clover", token: "t", storeTimezone: "America/Chicago", active };
}

function mutableReader(initial: SyncTarget[]): { reader: SyncTargetsReader; set(next: SyncTarget[]): void } {
  let targets = initial;
  const reader: SyncTargetsReader = {
    loadActive: async () => targets.filter((t) => t.active),
    get: async (id) => targets.find((t) => t.merchantId === id) ?? null,
    isActive: async (id) => targets.some((t) => t.merchantId === id && t.active),
    timezoneFor: async (id, fallback) => targets.find((t) => t.merchantId === id)?.storeTimezone ?? fallback,
  };
  return { reader, set: (next) => (targets = next) };
}

async function valueFor(merchantId: string, key: keyof ReturnType<typeof ensureBackfillGauges>) {
  const metric = await ensureBackfillGauges()[key].get();
  return metric.values.find((v) => v.labels.merchant_id === merchantId)?.value;
}

afterEach(() => {
  resetBackfillGauges();
});

describe("BackfillMetricsUpdater", () => {
  it("populates per-merchant gauges for every active sync target", async () => {
    const pool = new MockPool();
    const { reader } = mutableReader([target("m1", true), target("m2", true)]);
    const updater = new BackfillMetricsUpdater(pool as unknown as DbPool, config, reader);

    await updater.refresh(NOW);

    expect(pool.calls).toBe(2);
    expect(await valueFor("m1", "completedWindows")).toBe(1);
    expect(await valueFor("m1", "blockedWindows")).toBe(1);
    expect(await valueFor("m2", "blockedWindows")).toBe(1);
    // remaining windows present and stale clock anchored on lastCompletedAt
    expect(await valueFor("m1", "remainingWindows")).toBeGreaterThan(0);
    expect(await valueFor("m1", "secondsSinceLastCompleted")).toBeGreaterThan(0);
  });

  it("clears the series of a target that goes inactive", async () => {
    const pool = new MockPool();
    const { reader, set } = mutableReader([target("m1", true), target("m2", true)]);
    const updater = new BackfillMetricsUpdater(pool as unknown as DbPool, config, reader);

    await updater.refresh(NOW);
    expect(await valueFor("m2", "blockedWindows")).toBe(1);

    set([target("m1", true), target("m2", false)]);
    await updater.refresh(NOW);

    expect(await valueFor("m1", "blockedWindows")).toBe(1);
    expect(await valueFor("m2", "blockedWindows")).toBeUndefined();
  });

  it("does not throw when a target's summary query fails", async () => {
    const throwingPool = {
      async query() {
        throw new Error("db down");
      },
    };
    const { reader } = mutableReader([target("m1", true)]);
    const updater = new BackfillMetricsUpdater(throwingPool as unknown as DbPool, config, reader);

    await expect(updater.refresh(NOW)).resolves.toBeUndefined();
    expect(await valueFor("m1", "blockedWindows")).toBeUndefined();
  });
});
