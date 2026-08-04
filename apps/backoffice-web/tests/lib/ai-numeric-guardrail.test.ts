import { describe, expect, test } from "vitest";
import { findUnverifiedFigures } from "@/lib/ai/numeric-guardrail";

// Tool results mimic get_metric's shape: values are integer CENTS or RATIOS.
const netSalesResult = [{ output: { rows: [{ value: 123456 }], unit: "cents" } }];
const refundRateResult = [{ output: { rows: [{ value: 0.012 }], unit: "ratio" } }];
const orderCountResult = [{ output: { rows: [{ value: 1234 }], unit: "count" } }];

describe("findUnverifiedFigures", () => {
  test("a dollar claim that matches a cents tool value is sourced (not flagged)", () => {
    const flagged = findUnverifiedFigures("Net sales were $1,234.56 this week.", netSalesResult);
    expect(flagged).toEqual([]);
  });

  test("a dollar claim absent from the tool results is flagged", () => {
    const flagged = findUnverifiedFigures("Net sales were $9,999.00 this week.", netSalesResult);
    expect(flagged.map((f) => f.text)).toEqual(["$9,999.00"]);
  });

  test("a percent claim is matched against a ratio tool value (ratio↔percent)", () => {
    const flagged = findUnverifiedFigures("Your refund rate was 1.2%.", refundRateResult);
    expect(flagged).toEqual([]);
  });

  test("a comma-grouped count is sourced from a matching tool value", () => {
    const flagged = findUnverifiedFigures("You had 1,234 orders.", orderCountResult);
    expect(flagged).toEqual([]);
  });

  test("bare small integers are not treated as claims (no false alarms)", () => {
    const flagged = findUnverifiedFigures("Over the last 7 days your top 5 items sold well.", []);
    expect(flagged).toEqual([]);
  });

  test("a dollar figure stated with no tool call is flagged", () => {
    const flagged = findUnverifiedFigures("You made $5,000 today.", []);
    expect(flagged.map((f) => f.text)).toEqual(["$5,000"]);
  });

  test("only the unsourced figure is returned when an answer mixes both", () => {
    const flagged = findUnverifiedFigures(
      "Net sales were $1,234.56, but profit was $4,321.00.",
      netSalesResult,
    );
    expect(flagged.map((f) => f.text)).toEqual(["$4,321.00"]);
  });

  test("a repeated unsourced figure is reported once", () => {
    const flagged = findUnverifiedFigures("It was $9,999 — yes, $9,999.", netSalesResult);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.text).toBe("$9,999");
  });

  test("an empty answer yields no figures", () => {
    expect(findUnverifiedFigures("", netSalesResult)).toEqual([]);
  });
});
