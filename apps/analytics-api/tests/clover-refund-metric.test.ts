import { afterEach, describe, expect, it, vi } from "vitest";
import { CloverClient } from "../src/clover/client.js";
import { cloverV1RefundFetchFailuresTotal } from "../src/metrics/clover-refund-metrics.js";
import type { AppConfig } from "../src/config.js";

// GH #469: a swallowed v1 /refunds fetch failure is indistinguishable from "no
// refunds" and undercounts refunds. These tests prove the swallow is now
// observable (counter increments on failure) and that a genuine empty result
// does NOT trip the alert signal.

const config = {
  cloverBaseUrl: "https://api.clover.com",
  cloverRestMaxConcurrency: 4,
  cloverRestRequestsPerSecond: 1000
} as unknown as AppConfig;

async function failureCount(merchantId: string): Promise<number> {
  const snap = await cloverV1RefundFetchFailuresTotal.get();
  return snap.values.find((v) => v.labels.merchant_id === merchantId)?.value ?? 0;
}

describe("tryListV1Refunds failure metric (GH #469)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("increments the per-merchant failure counter and returns [] when the fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const client = new CloverClient(config, "MERCH_FAIL", "tok");
    const before = await failureCount("MERCH_FAIL");

    const result = await client.tryListV1Refunds();

    expect(result).toEqual([]);
    expect(await failureCount("MERCH_FAIL")).toBe(before + 1);
  });

  it("does NOT increment on a genuine empty (successful) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
      )
    );
    const client = new CloverClient(config, "MERCH_OK", "tok");
    const before = await failureCount("MERCH_OK");

    const result = await client.tryListV1Refunds();

    expect(result).toEqual([]);
    expect(await failureCount("MERCH_OK")).toBe(before);
  });
});
