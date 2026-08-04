import { describe, expect, test } from "vitest";
import { transformToTopItems } from "@/lib/analytics-api/top-items-transform";
import type { TopItemRow } from "@/lib/analytics-api/types";

function item(
  item_fingerprint: string,
  item_name: string,
  gross_sales_cents: number,
  quantity: number,
): TopItemRow {
  return {
    item_fingerprint,
    item_name,
    alternate_name: null,
    quantity,
    gross_sales_cents,
    modifier_total_cents: 0,
    line_count: quantity,
    modifier_line_count: 0,
  };
}

describe("transformToTopItems", () => {
  test("returns an empty top list for no rows", () => {
    expect(transformToTopItems([], 7)).toEqual({
      window_days: 7,
      total_items: 0,
      top: [],
    });
  });

  test("sorts by gross sales descending and assigns rank", () => {
    const result = transformToTopItems(
      [
        item("burger", "Burger", 1_000, 10),
        item("fries", "Fries", 3_000, 20),
        item("drink", "Drink", 2_000, 30),
      ],
      7,
    );

    expect(result.top.map((row) => row.item_name)).toEqual(["Fries", "Drink", "Burger"]);
    expect(result.top.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  test("uses quantity as a tie breaker and computes share of top", () => {
    const result = transformToTopItems(
      [item("a", "A", 4_000, 5), item("b", "B", 4_000, 8), item("c", "C", 2_000, 9)],
      7,
    );

    expect(result.top[0]!.item_name).toBe("B");
    expect(result.top[0]!.share_of_top).toBe(1);
    expect(result.top[1]!.share_of_top).toBe(1);
    expect(result.top[2]!.share_of_top).toBe(0.5);
  });

  test("limits rows and preserves total item count", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      item(`item-${index}`, `Item ${index}`, 10_000 - index * 1_000, index + 1),
    );

    const result = transformToTopItems(rows, 7, 5);

    expect(result.total_items).toBe(8);
    expect(result.top).toHaveLength(5);
    expect(result.top.at(-1)!.item_name).toBe("Item 4");
  });
});
