import { describe, expect, it } from "vitest";
import type { ActualCogsWindow } from "@rop/contracts";
import type { AppConfig } from "../src/config.js";
import type { DbPool } from "../src/db.js";
import { ActualCogsIngestWorker } from "../src/refresh/actual-cogs-ingest-worker.js";

const config = { actualCogsIngestIntervalSeconds: 300 } as AppConfig;
const pool = {} as unknown as DbPool;

function makeWindow(overrides: Partial<ActualCogsWindow> = {}): ActualCogsWindow {
  return {
    merchant_id: "M1",
    period_start: "2026-06-01",
    period_end: "2026-06-05",
    beginning_value_cents: 100_000,
    received_value_cents: 50_000,
    ending_value_cents: 120_000,
    actual_cogs_cents: 30_000,
    ...overrides
  };
}

describe("ActualCogsIngestWorker", () => {
  it("pulls windows from inventory-api and upserts them, returning the written count", async () => {
    const snapshots = [makeWindow(), makeWindow({ period_end: "2026-06-10" })];
    let fetchedConfig: AppConfig | null = null;
    let ingestedWindows: ActualCogsWindow[] | null = null;

    const worker = new ActualCogsIngestWorker(pool, config, {
      fetch: async (c) => {
        fetchedConfig = c;
        return { snapshots };
      },
      ingest: async (_pool, windows) => {
        ingestedWindows = windows;
        return { received: windows.length, written: windows.length };
      }
    });

    const written = await worker.tick();

    expect(written).toBe(2);
    expect(fetchedConfig).toBe(config);
    expect(ingestedWindows).toEqual(snapshots);
  });

  it("is best-effort: a failed inventory-api pull is swallowed so the loop survives", async () => {
    let ingestCalled = false;
    const worker = new ActualCogsIngestWorker(pool, config, {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      ingest: async () => {
        ingestCalled = true;
        return { received: 0, written: 0 };
      }
    });

    await expect(worker.tick()).resolves.toBe(0);
    expect(ingestCalled).toBe(false);
  });

  it("swallows an ingest failure too (the next tick recovers)", async () => {
    const worker = new ActualCogsIngestWorker(pool, config, {
      fetch: async () => ({ snapshots: [makeWindow()] }),
      ingest: async () => {
        throw new Error("db unavailable");
      }
    });

    await expect(worker.tick()).resolves.toBe(0);
  });
});
