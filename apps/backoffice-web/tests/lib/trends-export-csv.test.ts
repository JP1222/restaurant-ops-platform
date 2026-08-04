import { describe, expect, it } from "vitest";
import { buildTrendsCsv } from "@/lib/trends/export-csv";
import type { TrendsView } from "@/lib/analytics-api/trends-transform";

const view: TrendsView = {
  metric: "net_sales",
  granularity: "day",
  from: "2026-06-01",
  to: "2026-06-02",
  points: [
    { bucket_start: "2026-06-01", value: 123456, order_count: 20, net_sales_cents: 123456 },
    { bucket_start: "2026-06-02", value: 0, order_count: 0, net_sales_cents: 0 }
  ],
  totals: { net_sales_cents: 123456, order_count: 20, refund_total_cents: 0, discount_total_cents: 0 }
};

describe("buildTrendsCsv", () => {
  it("emits a header plus one row per bucket, dollars at 2dp", () => {
    const lines = buildTrendsCsv(view).split("\n");
    expect(lines[0]).toBe("Date,Net Sales ($),Orders,Avg Ticket ($)");
    expect(lines[1]).toBe("2026-06-01,1234.56,20,61.73");
  });

  it("guards divide-by-zero for a bucket with no orders", () => {
    const lines = buildTrendsCsv(view).split("\n");
    expect(lines[2]).toBe("2026-06-02,0.00,0,0.00");
  });
});
