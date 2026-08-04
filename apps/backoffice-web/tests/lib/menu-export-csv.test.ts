import { describe, expect, test } from "vitest";
import { buildMenuCsv } from "@/lib/menu/export-csv";
import { classifyMenu } from "@/lib/menu/kasavana-smith";
import type { MenuEngineeringInputRow } from "@/lib/analytics-api/types";

function inputRow(
  fingerprint: string,
  name: string,
  units: number,
  grossCents: number,
  plateCents: number | null
): MenuEngineeringInputRow {
  return {
    clover_item_id: fingerprint,
    item_fingerprint: fingerprint,
    item_name: name,
    units,
    gross_sales_cents: grossCents,
    plate_cost_cents: plateCents
  };
}

describe("buildMenuCsv", () => {
  test("emits a header and one row per active item, in rank order", () => {
    const view = classifyMenu(
      [
        inputRow("a", "Vanilla Roll", 100, 80_000, 200),
        inputRow("b", "Mango Roll", 400, 320_000, 300),
        inputRow("c", "No Recipe Roll", 50, 30_000, null)
      ],
      { popFactor: 0.7, windowDays: 30 }
    );

    const lines = buildMenuCsv(view).split("\n");

    expect(lines[0]).toBe(
      "Rank,Item,Quadrant,Units,Revenue,Plate cost,Contribution margin,Margin %"
    );
    // Two costed items only — the no-recipe item is excluded from the matrix.
    expect(lines).toHaveLength(3);
    // Mango ($5.00 margin x 400) outranks Vanilla, so it comes first.
    expect(lines[1]).toMatch(/^1,Mango Roll,/);
    expect(lines[2]).toMatch(/^2,Vanilla Roll,/);
  });

  test("escapes item names containing commas and quotes", () => {
    const view = classifyMenu(
      [inputRow("a", 'Roll, "Deluxe"', 100, 90_000, 250)],
      { popFactor: 0.7, windowDays: 30 }
    );

    const dataLine = buildMenuCsv(view).split("\n")[1];
    expect(dataLine).toContain('"Roll, ""Deluxe"""');
  });
});
