import { describe, expect, test } from "vitest";
import {
  classifyMenu,
  POP_FACTOR_DEFAULT,
  POP_FACTOR_MAX,
  POP_FACTOR_MIN
} from "@/lib/menu/kasavana-smith";
import type { MenuEngineeringInputRow } from "@/lib/analytics-api/types";

function row(
  partial: Partial<MenuEngineeringInputRow> &
    Pick<MenuEngineeringInputRow, "item_fingerprint" | "units" | "gross_sales_cents">
): MenuEngineeringInputRow {
  return {
    clover_item_id: partial.item_fingerprint,
    item_name: partial.item_fingerprint,
    plate_cost_cents: 0,
    ...partial
  };
}

// Hand-verifiable fixture. Realized unit price = gross_sales_cents / units.
//   A: 1000 units @ $8.00, cost $7.00 -> margin $1.00  (popular, thin)
//   B:  100 units @ $12.00, cost $3.00 -> margin $9.00 (niche, fat)
//   C:  800 units @ $8.00, cost $3.00 -> margin $5.00  (popular, fat)
//   D:  120 units @ $5.00, cost $4.20 -> margin $0.80  (niche, thin)
//   E:  200 units, no recipe -> cost unknown
const FIXTURE: MenuEngineeringInputRow[] = [
  row({ item_fingerprint: "A", units: 1000, gross_sales_cents: 800_000, plate_cost_cents: 700 }),
  row({ item_fingerprint: "B", units: 100, gross_sales_cents: 120_000, plate_cost_cents: 300 }),
  row({ item_fingerprint: "C", units: 800, gross_sales_cents: 640_000, plate_cost_cents: 300 }),
  row({ item_fingerprint: "D", units: 120, gross_sales_cents: 60_000, plate_cost_cents: 420 }),
  row({ item_fingerprint: "E", units: 200, gross_sales_cents: 130_000, plate_cost_cents: null })
];

function quadrants(view: ReturnType<typeof classifyMenu>): Record<string, string> {
  return Object.fromEntries(view.items.map((i) => [i.item_fingerprint, i.quadrant]));
}

describe("classifyMenu — Kasavana-Smith over realized margin", () => {
  test("classifies on contribution margin, not revenue (the bug fix)", () => {
    const view = classifyMenu(FIXTURE, { popFactor: 0.7, windowDays: 30 });
    const q = quadrants(view);

    // A has the HIGHEST revenue ($8,000) but the thinnest margin among the
    // popular items: it must be a Plowhorse, never a Star.
    expect(q.A).toBe("plowhorse");
    expect(q.C).toBe("star"); // popular AND high margin
    expect(q.B).toBe("puzzle"); // niche but fat margin
    expect(q.D).toBe("dog"); // niche and thin
  });

  test("derives realized unit price and per-unit margin from gross sales / units", () => {
    const view = classifyMenu(FIXTURE, { popFactor: 0.7, windowDays: 30 });
    const a = view.items.find((i) => i.item_fingerprint === "A");

    expect(a?.unit_price_cents).toBe(800); // 800_000 / 1000
    expect(a?.margin_cents).toBe(100); // 800 - 700
    expect(a?.margin_pct).toBeCloseTo(0.125, 5); // 100 / 800
    expect(a?.contribution_cents).toBe(100_000); // 100 * 1000
  });

  test("thresholds: X = (1/N)*popFactor, Y = units-weighted avg margin", () => {
    const view = classifyMenu(FIXTURE, { popFactor: 0.7, windowDays: 30 });

    expect(view.activeCount).toBe(4);
    expect(view.totalUnits).toBe(2020);
    expect(view.xThreshold).toBeCloseTo(0.175, 6); // (1/4) * 0.7
    // (100*1000 + 900*100 + 500*800 + 80*120) / 2020 = 599600 / 2020
    expect(view.yThresholdCents).toBeCloseTo(296.8317, 3);
  });

  test("excludes cost-unknown items from the matrix — never coerced to $0", () => {
    const view = classifyMenu(FIXTURE, { popFactor: 0.7, windowDays: 30 });

    expect(view.items.map((i) => i.item_fingerprint)).not.toContain("E");
    expect(view.costUnknown).toHaveLength(1);
    expect(view.costUnknown[0]).toMatchObject({
      item_fingerprint: "E",
      units: 200,
      unit_price_cents: 650 // still priced for display: 130_000 / 200
    });
  });

  test("ranks by contribution dollars, not revenue", () => {
    const view = classifyMenu(FIXTURE, { popFactor: 0.7, windowDays: 30 });
    const ranked = [...view.items].sort((a, b) => a.rank - b.rank);

    // C contributes $4,000 (rank 1) though A has higher revenue ($8,000 vs $6,400).
    expect(ranked.map((i) => i.item_fingerprint)).toEqual(["C", "A", "B", "D"]);
    expect(view.totalContributionCents).toBe(599_600);
    expect(view.counts).toEqual({ star: 1, plowhorse: 1, puzzle: 1, dog: 1 });
  });

  test("popularity factor reclassifies live without new data", () => {
    const twoItems: MenuEngineeringInputRow[] = [
      row({ item_fingerprint: "P", units: 600, gross_sales_cents: 600_000, plate_cost_cents: 200 }),
      row({ item_fingerprint: "Q", units: 400, gross_sales_cents: 400_000, plate_cost_cents: 200 })
    ];

    // N=2 -> xThreshold = 0.5 * popFactor. Q's mix is 0.4.
    const loose = classifyMenu(twoItems, { popFactor: 0.7, windowDays: 30 });
    expect(loose.xThreshold).toBeCloseTo(0.35, 6);
    expect(quadrants(loose).Q).toBe("star"); // 0.4 >= 0.35 -> popular

    const strict = classifyMenu(twoItems, { popFactor: 1.0, windowDays: 30 });
    expect(strict.xThreshold).toBeCloseTo(0.5, 6);
    expect(quadrants(strict).Q).toBe("puzzle"); // 0.4 < 0.5 -> no longer popular
  });

  test("clamps the popularity factor into [MIN, MAX]", () => {
    expect(classifyMenu(FIXTURE, { popFactor: 5, windowDays: 30 }).popFactor).toBe(POP_FACTOR_MAX);
    expect(classifyMenu(FIXTURE, { popFactor: 0.1, windowDays: 30 }).popFactor).toBe(POP_FACTOR_MIN);
    expect(classifyMenu(FIXTURE, { popFactor: Number.NaN, windowDays: 30 }).popFactor).toBe(
      POP_FACTOR_DEFAULT
    );
  });

  test("degenerate inputs: empty and all-unknown yield an empty matrix", () => {
    const empty = classifyMenu([], { popFactor: 0.7, windowDays: 30 });
    expect(empty.items).toHaveLength(0);
    expect(empty.activeCount).toBe(0);
    expect(empty.xThreshold).toBe(0);

    const allUnknown = classifyMenu(
      [row({ item_fingerprint: "X", units: 50, gross_sales_cents: 25_000, plate_cost_cents: null })],
      { popFactor: 0.7, windowDays: 30 }
    );
    expect(allUnknown.items).toHaveLength(0);
    expect(allUnknown.costUnknown).toHaveLength(1);
    expect(allUnknown.counts).toEqual({ star: 0, plowhorse: 0, puzzle: 0, dog: 0 });
  });
});
