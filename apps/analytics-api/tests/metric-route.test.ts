import { describe, expect, it } from "vitest";
import { parseMetricRequest } from "../src/http/metric-route.js";

describe("parseMetricRequest", () => {
  it("accepts a days window", () => {
    const r = parseMetricRequest({ name: "net_sales_cents", window: { mode: "days", days: 30 } });
    expect(r.name).toBe("net_sales_cents");
    expect(r.window).toEqual({ mode: "days", days: 30 });
  });

  it("accepts a range window with dimensions and filters", () => {
    const r = parseMetricRequest({
      name: "cash_sales_cents",
      window: { mode: "range", from: "2026-06-01", to: "2026-06-02" },
      dimensions: ["business_date"],
      filters: { tender_type: "CASH" },
    });
    expect(r.dimensions).toEqual(["business_date"]);
    expect(r.filters).toEqual({ tender_type: "CASH" });
  });

  it("rejects a missing name", () => {
    expect(() => parseMetricRequest({ window: { mode: "days", days: 7 } })).toThrow();
  });

  it("rejects an unknown window mode", () => {
    expect(() => parseMetricRequest({ name: "x", window: { mode: "month" } })).toThrow();
  });

  it("rejects a non-ISO range date", () => {
    expect(() =>
      parseMetricRequest({ name: "x", window: { mode: "range", from: "2026/06/01", to: "2026-06-02" } }),
    ).toThrow();
  });

  it("rejects a non-string filter value", () => {
    expect(() =>
      parseMetricRequest({ name: "x", window: { mode: "days", days: 7 }, filters: { tender_type: 5 } }),
    ).toThrow();
  });

  it("rejects days below 1", () => {
    expect(() => parseMetricRequest({ name: "x", window: { mode: "days", days: 0 } })).toThrow();
  });
});
