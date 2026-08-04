import { describe, expect, test, vi } from "vitest";

// Stub `next/headers` (only the symbols we touch) so `fetchInternalApi` is
// importable in a vitest happy-dom environment. We never execute the tool
// callbacks in this suite — we only assert their input schemas parse correctly.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

import { aiTools } from "@/lib/ai/tools";

function parseInput(name: keyof typeof aiTools, input: unknown) {
  const schema = aiTools[name].inputSchema;
  if (!schema || typeof schema !== "object" || !("parse" in schema)) {
    throw new Error(`tool ${name} missing zod inputSchema`);
  }
  // Zod schemas have a `parse` method we use directly here.
  return (schema as { parse: (i: unknown) => unknown }).parse(input);
}

describe("aiTools input schemas", () => {
  test("get_today_overview accepts empty input", () => {
    const parsed = parseInput("get_today_overview", {});
    expect(parsed).toEqual({});
  });

  test("get_today_hourly defaults days to 30 and accepts 7..90", () => {
    const defaulted = parseInput("get_today_hourly", {}) as { days: number };
    expect(defaulted.days).toBe(30);

    const custom = parseInput("get_today_hourly", { days: 60 }) as { days: number };
    expect(custom.days).toBe(60);

    expect(() => parseInput("get_today_hourly", { days: 6 })).toThrow();
    expect(() => parseInput("get_today_hourly", { days: 91 })).toThrow();
  });

  test("get_today_insights accepts empty input", () => {
    const parsed = parseInput("get_today_insights", {});
    expect(parsed).toEqual({});
  });

  test("get_top_items defaults days to 7 and accepts 1..90", () => {
    const defaulted = parseInput("get_top_items", {}) as { days: number };
    expect(defaulted.days).toBe(7);

    const custom = parseInput("get_top_items", { days: 14 }) as { days: number };
    expect(custom.days).toBe(14);

    expect(() => parseInput("get_top_items", { days: 0 })).toThrow();
    expect(() => parseInput("get_top_items", { days: 91 })).toThrow();
  });

  test("get_week_over_week accepts empty input", () => {
    const parsed = parseInput("get_week_over_week", {});
    expect(parsed).toEqual({});
  });

  test("get_trends requires from/to/metric/grain and validates ISO date + enums", () => {
    const parsed = parseInput("get_trends", {
      from: "2026-04-01",
      to: "2026-04-30",
      metric: "net_sales",
      grain: "day",
    }) as { from: string; to: string; metric: string; grain: string };
    expect(parsed.metric).toBe("net_sales");
    expect(parsed.grain).toBe("day");

    expect(() =>
      parseInput("get_trends", {
        from: "2026-4-1",
        to: "2026-04-30",
        metric: "net_sales",
        grain: "day",
      }),
    ).toThrow();
    expect(() =>
      parseInput("get_trends", {
        from: "2026-04-01",
        to: "2026-04-30",
        metric: "bogus",
        grain: "day",
      }),
    ).toThrow();
  });

  test("compare_periods requires all four dates + metric + grain", () => {
    const parsed = parseInput("compare_periods", {
      primary_from: "2026-04-01",
      primary_to: "2026-04-07",
      compare_from: "2026-03-25",
      compare_to: "2026-03-31",
      metric: "orders",
      grain: "day",
    }) as Record<string, string>;
    expect(parsed.primary_from).toBe("2026-04-01");
    expect(parsed.metric).toBe("orders");

    expect(() =>
      parseInput("compare_periods", {
        primary_from: "2026-04-01",
        primary_to: "2026-04-07",
        compare_from: "2026-03-25",
        compare_to: "not-a-date",
        metric: "orders",
        grain: "day",
      }),
    ).toThrow();
  });

  test("get_sync_health accepts empty input", () => {
    const parsed = parseInput("get_sync_health", {});
    expect(parsed).toEqual({});
  });

  test("get_database_stats accepts empty input", () => {
    const parsed = parseInput("get_database_stats", {});
    expect(parsed).toEqual({});
  });

  test("get_menu_items defaults days to 30 and accepts 7..90", () => {
    const defaulted = parseInput("get_menu_items", {}) as { days: number };
    expect(defaulted.days).toBe(30);

    const custom = parseInput("get_menu_items", { days: 90 }) as { days: number };
    expect(custom.days).toBe(90);

    expect(() => parseInput("get_menu_items", { days: 6 })).toThrow();
    expect(() => parseInput("get_menu_items", { days: 91 })).toThrow();
  });

  test("get_menu_item_modifiers requires item_fingerprint and defaults days to 30", () => {
    const parsed = parseInput("get_menu_item_modifiers", {
      item_fingerprint: "fp-burger-deluxe",
    }) as { item_fingerprint: string; days: number };
    expect(parsed.item_fingerprint).toBe("fp-burger-deluxe");
    expect(parsed.days).toBe(30);

    expect(() => parseInput("get_menu_item_modifiers", {})).toThrow();
    expect(() =>
      parseInput("get_menu_item_modifiers", { item_fingerprint: "" }),
    ).toThrow();
  });

  test("list_metrics accepts empty input and advertises catalog discovery", () => {
    expect(parseInput("list_metrics", {})).toEqual({});
    expect(aiTools.list_metrics.description ?? "").toMatch(/list the governed business metrics/i);
  });

  test("get_metric requires name + window, accepts dimensions/filters, and validates the window", () => {
    const days = parseInput("get_metric", {
      name: "net_sales_cents",
      window: { mode: "days", days: 30 },
    }) as { name: string; window: { mode: string; days: number } };
    expect(days.name).toBe("net_sales_cents");
    expect(days.window).toEqual({ mode: "days", days: 30 });

    const range = parseInput("get_metric", {
      name: "cash_sales_cents",
      window: { mode: "range", from: "2026-06-01", to: "2026-06-02" },
      dimensions: ["business_date"],
      filters: { tender_type: "CASH" },
    }) as { dimensions: string[]; filters: Record<string, string> };
    expect(range.dimensions).toEqual(["business_date"]);
    expect(range.filters).toEqual({ tender_type: "CASH" });

    expect(() => parseInput("get_metric", { window: { mode: "days", days: 7 } })).toThrow();
    expect(() => parseInput("get_metric", { name: "x", window: { mode: "month" } })).toThrow();
    expect(() =>
      parseInput("get_metric", {
        name: "x",
        window: { mode: "range", from: "2026/06/01", to: "2026-06-02" },
      }),
    ).toThrow();
    expect(() => parseInput("get_metric", { name: "x", window: { mode: "days", days: 0 } })).toThrow();

    // The description must steer the model to prefer get_metric for reportable KPIs.
    expect(aiTools.get_metric.description ?? "").toMatch(/PREFER this over run_sql_query/);
  });

  test("get_metric_anomaly requires name, accepts optional days (8..365) + ISO as_of", () => {
    const minimal = parseInput("get_metric_anomaly", { name: "net_sales_cents" }) as {
      name: string;
      days?: number;
      as_of?: string;
    };
    expect(minimal.name).toBe("net_sales_cents");
    expect(minimal.days).toBeUndefined();

    const full = parseInput("get_metric_anomaly", {
      name: "food_cost_pct",
      days: 60,
      as_of: "2026-06-01",
    }) as { days: number; as_of: string };
    expect(full.days).toBe(60);
    expect(full.as_of).toBe("2026-06-01");

    expect(() => parseInput("get_metric_anomaly", {})).toThrow(); // name required
    expect(() => parseInput("get_metric_anomaly", { name: "x", days: 7 })).toThrow(); // < 8
    expect(() => parseInput("get_metric_anomaly", { name: "x", days: 366 })).toThrow();
    expect(() =>
      parseInput("get_metric_anomaly", { name: "x", as_of: "2026/06/01" }),
    ).toThrow();

    // The description must steer the model to ground the verdict, not eyeball it.
    expect(aiTools.get_metric_anomaly.description ?? "").toMatch(/percentile|z-score/i);
  });

  test("get_data_trust accepts empty input, optional ISO date + lookback_days (2..30), and steers off alarming on settling days", () => {
    expect(parseInput("get_data_trust", {})).toEqual({});

    const full = parseInput("get_data_trust", { date: "2026-06-01", lookback_days: 14 }) as {
      date: string;
      lookback_days: number;
    };
    expect(full.date).toBe("2026-06-01");
    expect(full.lookback_days).toBe(14);

    expect(() => parseInput("get_data_trust", { date: "2026/06/01" })).toThrow();
    expect(() => parseInput("get_data_trust", { lookback_days: 1 })).toThrow();
    expect(() => parseInput("get_data_trust", { lookback_days: 31 })).toThrow();

    // It's a read tool, and the description must warn against alarming on the settling window.
    expect(aiTools.get_data_trust.needsApproval).toBeUndefined();
    const desc = (aiTools.get_data_trust.description ?? "").toLowerCase();
    expect(desc).toMatch(/reconcil/);
    expect(desc).toMatch(/pending|settling/);
  });

  test("run_sql_query schema accepts 20..2000 char sql + optional question, and description names the safe-query constraints", () => {
    const minimal = "SELECT business_date FROM mart.daily_sales LIMIT 10;";
    const parsed = parseInput("run_sql_query", { sql: minimal }) as {
      sql: string;
      question?: string;
    };
    expect(parsed.sql).toBe(minimal);
    expect(parsed.question).toBeUndefined();

    const withQuestion = parseInput("run_sql_query", {
      sql: minimal,
      question: "Show me recent business dates",
    }) as { sql: string; question?: string };
    expect(withQuestion.question).toBe("Show me recent business dates");

    expect(() => parseInput("run_sql_query", { sql: "SELECT 1;" })).toThrow();
    expect(() => parseInput("run_sql_query", { sql: "x".repeat(2001) })).toThrow();

    // The model needs to see the safe-query gate constraints in the description
    // (Phase 7 plan §"Cross-step contracts": run_sql_query description MUST
    // include "read-only", "SELECT or WITH", and "mart/meta schemas only").
    const desc = aiTools.run_sql_query.description ?? "";
    expect(desc.toLowerCase()).toMatch(/read-only/);
    expect(desc).toMatch(/SELECT/);
    expect(desc).toMatch(/WITH/);
    expect(desc.toLowerCase()).toMatch(/mart\/meta|mart\s+(and|or|\/)\s+meta/);
  });

  test("get_inventory_status accepts empty input and is described as live on-hand stock", () => {
    expect(parseInput("get_inventory_status", {})).toEqual({});
    const desc = (aiTools.get_inventory_status.description ?? "").toLowerCase();
    expect(desc).toMatch(/on-hand|inventory/);
    expect(desc).toMatch(/not sales|stock, not sales/);
  });

  test("find_inventory_item requires a 1..80 char query", () => {
    const parsed = parseInput("find_inventory_item", { query: "pearls" }) as { query: string };
    expect(parsed.query).toBe("pearls");

    expect(() => parseInput("find_inventory_item", {})).toThrow();
    expect(() => parseInput("find_inventory_item", { query: "" })).toThrow();
    expect(() => parseInput("find_inventory_item", { query: "x".repeat(81) })).toThrow();
  });

  test("compare_vendor_prices requires a 1..80 char query and reads cheapest-first", () => {
    const parsed = parseInput("compare_vendor_prices", { query: "milk" }) as { query: string };
    expect(parsed.query).toBe("milk");
    expect(() => parseInput("compare_vendor_prices", { query: "" })).toThrow();
    expect(() => parseInput("compare_vendor_prices", { query: "x".repeat(81) })).toThrow();

    const desc = (aiTools.compare_vendor_prices.description ?? "").toLowerCase();
    expect(desc).toMatch(/cheapest|vendor/);
    expect(desc).toMatch(/last|not a live quote/);
    expect(aiTools.compare_vendor_prices.needsApproval).toBeUndefined();
  });

  test("write tools are gated behind needsApproval", () => {
    expect(aiTools.record_receiving.needsApproval).toBe(true);
    expect(aiTools.record_waste.needsApproval).toBe(true);
    expect(aiTools.set_inventory_count.needsApproval).toBe(true);
    // Read tools must NOT require approval.
    expect(aiTools.get_inventory_status.needsApproval).toBeUndefined();
    expect(aiTools.find_inventory_item.needsApproval).toBeUndefined();
  });

  test("web_search requires a 1..200 char query, is read-only (no needsApproval), and steers off store KPIs", () => {
    const parsed = parseInput("web_search", { query: "wholesale boba price" }) as { query: string };
    expect(parsed.query).toBe("wholesale boba price");

    expect(() => parseInput("web_search", {})).toThrow();
    expect(() => parseInput("web_search", { query: "" })).toThrow();
    expect(() => parseInput("web_search", { query: "x".repeat(201) })).toThrow();

    // Read-only: injected web text can at most make the model PROPOSE a write,
    // which still hits the inventory Confirm gate. web_search itself is ungated.
    expect(aiTools.web_search.needsApproval).toBeUndefined();

    const desc = (aiTools.web_search.description ?? "").toLowerCase();
    expect(desc).toMatch(/web/);
    expect(desc).toMatch(/get_metric|store kpis|untrusted/);
  });

  test("record_receiving requires item + positive quantity, note optional", () => {
    const parsed = parseInput("record_receiving", { item: "cups", quantity: 5 }) as {
      item: string;
      quantity: number;
    };
    expect(parsed).toEqual({ item: "cups", quantity: 5 });

    expect(() => parseInput("record_receiving", { item: "cups" })).toThrow();
    expect(() => parseInput("record_receiving", { item: "cups", quantity: 0 })).toThrow();
    expect(() => parseInput("record_receiving", { item: "", quantity: 5 })).toThrow();
  });

  test("record_waste requires item + positive quantity + a valid reason enum", () => {
    const parsed = parseInput("record_waste", {
      item: "milk",
      quantity: 2,
      reason: "spoilage",
    }) as { reason: string };
    expect(parsed.reason).toBe("spoilage");

    expect(() => parseInput("record_waste", { item: "milk", quantity: 2 })).toThrow();
    expect(() =>
      parseInput("record_waste", { item: "milk", quantity: 2, reason: "bogus" }),
    ).toThrow();
  });

  test("set_inventory_count requires item + non-negative counted_quantity", () => {
    const parsed = parseInput("set_inventory_count", { item: "straws", counted_quantity: 0 }) as {
      counted_quantity: number;
    };
    expect(parsed.counted_quantity).toBe(0);

    expect(() => parseInput("set_inventory_count", { item: "straws" })).toThrow();
    expect(() =>
      parseInput("set_inventory_count", { item: "straws", counted_quantity: -1 }),
    ).toThrow();
  });
});
