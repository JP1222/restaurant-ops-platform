import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { SyncTargetsRepository } from "../src/sync-targets/repository.js";

type Row = {
  merchant_id: string;
  provider: string;
  token: string;
  store_timezone: string;
  active: boolean;
};

class FakePool {
  calls: Array<{ sql: string; params?: unknown[] }> = [];

  constructor(
    private rows: Row[] = [],
    private existing = false
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT 1 FROM config.sync_targets")) {
      return { rows: this.existing ? [{ ok: 1 }] : [], rowCount: this.existing ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO config.sync_targets")) {
      this.existing = true;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM config.sync_targets")) {
      return { rows: this.rows, rowCount: this.rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

function row(merchantId: string, timezone: string, active: boolean): Row {
  return { merchant_id: merchantId, provider: "clover", token: `tok-${merchantId}`, store_timezone: timezone, active };
}

const envConfig = {
  cloverMerchantId: "merchant1",
  cloverToken: "env-token",
  storeTimezone: "America/Chicago"
} as AppConfig;

describe("SyncTargetsRepository", () => {
  it("seeds one target from env when the table is empty", async () => {
    const pool = new FakePool([], false);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    await repo.seedFromEnvIfEmpty(envConfig);

    const insert = pool.calls.find((c) => c.sql.includes("INSERT INTO config.sync_targets"));
    expect(insert).toBeDefined();
    expect(insert?.params?.[0]).toBe("merchant1");
    expect(insert?.params?.[2]).toBe("env-token");
  });

  it("does not seed when the table already has rows", async () => {
    const pool = new FakePool([], true);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    await repo.seedFromEnvIfEmpty(envConfig);

    expect(pool.calls.some((c) => c.sql.includes("INSERT INTO config.sync_targets"))).toBe(false);
  });

  it("does not seed when env credentials are absent", async () => {
    const pool = new FakePool([], false);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    await repo.seedFromEnvIfEmpty({ storeTimezone: "America/Chicago" } as AppConfig);

    expect(pool.calls).toHaveLength(0);
  });

  it("loadActive returns only active targets", async () => {
    const pool = new FakePool([
      row("m1", "America/Chicago", true),
      row("m2", "America/New_York", false)
    ]);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    const active = await repo.loadActive();

    expect(active.map((t) => t.merchantId)).toEqual(["m1"]);
  });

  it("isActive reflects the active flag per merchant", async () => {
    const pool = new FakePool([
      row("m1", "America/Chicago", true),
      row("m2", "America/New_York", false)
    ]);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    expect(await repo.isActive("m1")).toBe(true);
    expect(await repo.isActive("m2")).toBe(false);
    expect(await repo.isActive("unknown")).toBe(false);
  });

  it("timezoneFor returns the store's timezone, or the fallback when unknown", async () => {
    const pool = new FakePool([row("m2", "America/New_York", false)]);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    expect(await repo.timezoneFor("m2", "UTC")).toBe("America/New_York");
    expect(await repo.timezoneFor("missing", "UTC")).toBe("UTC");
  });

  it("caches reads until invalidated", async () => {
    const pool = new FakePool([row("m1", "America/Chicago", true)]);
    const repo = new SyncTargetsRepository(pool as unknown as DbPool);

    await repo.loadActive();
    await repo.loadActive();
    const selectCount = pool.calls.filter((c) => c.sql.includes("SELECT merchant_id")).length;
    expect(selectCount).toBe(1);

    repo.invalidate();
    await repo.loadActive();
    const afterInvalidate = pool.calls.filter((c) => c.sql.includes("SELECT merchant_id")).length;
    expect(afterInvalidate).toBe(2);
  });
});
