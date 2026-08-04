import { describe, expect, test } from "vitest";
import { scoreAll, scoreCase, type Transcript } from "@/lib/ai/eval/score";
import type { GoldenCase } from "@/lib/ai/eval/golden";

const netSalesCase: GoldenCase = {
  id: "net-sales",
  question: "net sales?",
  expectTool: "get_metric",
  expectMetric: "net_sales_cents",
  mustBeGrounded: true,
};

// get_metric tool result mimics the real shape (value in CENTS).
const netSalesResult = [{ output: { rows: [{ value: 123456 }], unit: "cents" } }];

describe("scoreCase", () => {
  test("passes on the expected tool + metric with a grounded answer", () => {
    const transcript: Transcript = {
      toolCalls: [{ toolName: "get_metric", input: { name: "net_sales_cents" } }],
      toolResults: netSalesResult,
      finalText: "Net sales were $1,234.56 over the last 7 days.",
    };
    expect(scoreCase(netSalesCase, transcript)).toMatchObject({
      toolMatch: true,
      metricMatch: true,
      grounded: true,
      pass: true,
    });
  });

  test("fails when the wrong tool is used", () => {
    const transcript: Transcript = {
      toolCalls: [{ toolName: "run_sql_query", input: { sql: "select 1" } }],
      finalText: "I ran a query.",
    };
    const score = scoreCase(netSalesCase, transcript);
    expect(score.toolMatch).toBe(false);
    expect(score.pass).toBe(false);
  });

  test("fails when get_metric requests the wrong metric name", () => {
    const transcript: Transcript = {
      toolCalls: [{ toolName: "get_metric", input: { name: "order_count" } }],
      toolResults: [],
      finalText: "Here you go.",
    };
    const score = scoreCase(netSalesCase, transcript);
    expect(score.toolMatch).toBe(true);
    expect(score.metricMatch).toBe(false);
    expect(score.pass).toBe(false);
  });

  test("fails a grounded case when the answer states an unsourced figure", () => {
    const transcript: Transcript = {
      toolCalls: [{ toolName: "get_metric", input: { name: "net_sales_cents" } }],
      toolResults: netSalesResult,
      finalText: "Net sales were $9,999.00.",
    };
    const score = scoreCase(netSalesCase, transcript);
    expect(score.metricMatch).toBe(true);
    expect(score.grounded).toBe(false);
    expect(score.pass).toBe(false);
  });

  test("a list_metrics case passes on tool match alone", () => {
    const listCase: GoldenCase = { id: "cat", question: "what metrics?", expectTool: "list_metrics" };
    const transcript: Transcript = {
      toolCalls: [{ toolName: "list_metrics", input: {} }],
      finalText: "Here are the available metrics.",
    };
    expect(scoreCase(listCase, transcript).pass).toBe(true);
  });
});

describe("scoreAll", () => {
  test("a missing transcript scores as a fail and passRate reflects the rest", () => {
    const cases: GoldenCase[] = [
      { id: "a", question: "", expectTool: "get_metric", expectMetric: "net_sales_cents" },
      { id: "b", question: "", expectTool: "list_metrics" },
    ];
    const transcripts = new Map<string, Transcript>([
      ["b", { toolCalls: [{ toolName: "list_metrics", input: {} }], finalText: "" }],
    ]);
    const card = scoreAll(cases, transcripts);
    expect(card.total).toBe(2);
    expect(card.passed).toBe(1);
    expect(card.passRate).toBe(0.5);
    expect(card.cases.find((c) => c.id === "a")?.pass).toBe(false);
  });
});
