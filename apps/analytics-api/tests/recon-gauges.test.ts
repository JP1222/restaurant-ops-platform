import { afterEach, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { handleMetrics } from "../src/http/metrics.js";
import {
  ensureReconGauges,
  epochSecondsOrNull,
  recordReconSummary,
  resetReconGauges,
  type ReconSummaryForGauges,
} from "../src/metrics/recon-gauges.js";

function summary(overrides: Partial<ReconSummaryForGauges> = {}): ReconSummaryForGauges {
  return {
    unresolvedBreakDays: 2,
    oldestUnresolvedBreakDay: "2026-06-08",
    lastRunAt: "2026-06-16T13:30:00.000Z",
    ...overrides,
  };
}

type Gauge = ReturnType<typeof ensureReconGauges>["unresolvedBreakDays"];

async function valueFor(gauge: Gauge, merchantId: string) {
  const metric = await gauge.get();
  return metric.values.find((v) => v.labels.merchant_id === merchantId)?.value;
}

afterEach(() => {
  resetReconGauges();
});

describe("epochSecondsOrNull", () => {
  it("converts an ISO date to UTC-midnight epoch seconds", () => {
    expect(epochSecondsOrNull("2026-06-08")).toBe(Date.UTC(2026, 5, 8) / 1000);
  });

  it("converts an ISO timestamp to epoch seconds", () => {
    expect(epochSecondsOrNull("2026-06-16T13:30:00.000Z")).toBe(
      Date.parse("2026-06-16T13:30:00.000Z") / 1000,
    );
  });

  it("is null for null or unparseable input rather than NaN/0", () => {
    expect(epochSecondsOrNull(null)).toBeNull();
    expect(epochSecondsOrNull("not-a-date")).toBeNull();
  });
});

describe("recordReconSummary", () => {
  it("sets every gauge for the merchant, labelled by merchant_id", async () => {
    const gauges = ensureReconGauges();
    recordReconSummary("m1", summary());

    expect(await valueFor(gauges.unresolvedBreakDays, "m1")).toBe(2);
    expect(await valueFor(gauges.oldestUnresolvedBreakDay, "m1")).toBe(
      Date.UTC(2026, 5, 8) / 1000,
    );
    expect(await valueFor(gauges.lastRunTimestamp, "m1")).toBe(
      Date.parse("2026-06-16T13:30:00.000Z") / 1000,
    );
  });

  it("leaves oldest-break absent when there are no breaks", async () => {
    const gauges = ensureReconGauges();
    recordReconSummary("m1", summary({ unresolvedBreakDays: 0, oldestUnresolvedBreakDay: null }));

    expect(await valueFor(gauges.unresolvedBreakDays, "m1")).toBe(0);
    expect(await valueFor(gauges.oldestUnresolvedBreakDay, "m1")).toBeUndefined();
  });

  it("leaves last-run absent when the reconciler has never run", async () => {
    const gauges = ensureReconGauges();
    recordReconSummary("m1", summary({ lastRunAt: null }));

    expect(await valueFor(gauges.lastRunTimestamp, "m1")).toBeUndefined();
  });

  it("keeps separate series per merchant (multi-location)", async () => {
    const gauges = ensureReconGauges();
    recordReconSummary("m1", summary({ unresolvedBreakDays: 3 }));
    recordReconSummary("m2", summary({ unresolvedBreakDays: 0, oldestUnresolvedBreakDay: null }));

    expect(await valueFor(gauges.unresolvedBreakDays, "m1")).toBe(3);
    expect(await valueFor(gauges.unresolvedBreakDays, "m2")).toBe(0);
  });
});

describe("resetReconGauges", () => {
  it("clears all per-merchant series", async () => {
    const gauges = ensureReconGauges();
    recordReconSummary("m1", summary());
    expect(await valueFor(gauges.unresolvedBreakDays, "m1")).toBe(2);

    resetReconGauges();
    expect((await gauges.unresolvedBreakDays.get()).values).toHaveLength(0);
  });
});

describe("/metrics integration", () => {
  it("exposes the rop_recon_* gauges in the Prometheus text format", async () => {
    recordReconSummary("m1", summary({ unresolvedBreakDays: 1 }));

    const body = { value: "" };
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      setHeader(key: string, value: string) {
        this.headers[key] = value;
      },
      end(chunk = "") {
        body.value = chunk;
      },
    } as ServerResponse & { headers: Record<string, string> };

    await handleMetrics(res);

    expect(body.value).toContain("rop_recon_unresolved_break_days");
    expect(body.value).toContain("rop_recon_last_run_timestamp");
    expect(body.value).toContain('merchant_id="m1"');
  });
});
