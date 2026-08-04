import type { TopItemRow } from "./types";

export interface TopItemView {
  rank: number;
  item_fingerprint: string;
  item_name: string;
  alternate_name: string | null;
  quantity: number;
  gross_sales_cents: number;
  modifier_total_cents: number;
  line_count: number;
  modifier_line_count: number;
  share_of_top: number;
}

export interface TopItemsView {
  window_days: number;
  total_items: number;
  top: TopItemView[];
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function transformToTopItems(
  rows: TopItemRow[],
  windowDays: number,
  limit = 5,
): TopItemsView {
  const sorted = [...rows].sort((a, b) => {
    const salesDelta = toNumber(b.gross_sales_cents) - toNumber(a.gross_sales_cents);
    if (salesDelta !== 0) return salesDelta;

    return toNumber(b.quantity) - toNumber(a.quantity);
  });

  const topRows = sorted.slice(0, limit);
  const topSales = toNumber(topRows[0]?.gross_sales_cents);

  return {
    window_days: windowDays,
    total_items: rows.length,
    top: topRows.map((row, index) => {
      const grossSalesCents = toNumber(row.gross_sales_cents);

      return {
        rank: index + 1,
        item_fingerprint: row.item_fingerprint,
        item_name: row.item_name,
        alternate_name: row.alternate_name,
        quantity: toNumber(row.quantity),
        gross_sales_cents: grossSalesCents,
        modifier_total_cents: toNumber(row.modifier_total_cents),
        line_count: toNumber(row.line_count),
        modifier_line_count: toNumber(row.modifier_line_count),
        share_of_top: topSales > 0 ? grossSalesCents / topSales : 0,
      };
    }),
  };
}
