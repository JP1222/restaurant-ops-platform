import type { BreakdownRow } from "@/lib/analytics-api/types";

export type SegmentDim = "order_type" | "tender" | "daypart";

// Daypart keys mirror the analytics handler's CASE buckets and the Dayparts page
// (breakfast 5-10, lunch 11-14, dinner 17-21, else off-peak).
export const DAYPART_LABELS: Record<string, string> = {
  breakfast: "Breakfast (5–10)",
  lunch: "Lunch (11–14)",
  dinner: "Dinner (17–21)",
  offpeak: "Off-peak",
};

// Normalized tender types from the analytics pipeline (CASH / CREDIT_CARD / ...).
const TENDER_LABELS: Record<string, string> = {
  CASH: "Cash",
  CREDIT_CARD: "Card",
  GIFT_CARD: "Gift card",
  OTHER: "Other",
  UNKNOWN: "Unknown",
};

export function segmentLabel(dim: SegmentDim, key: string): string {
  if (dim === "daypart") return DAYPART_LABELS[key] ?? key;
  if (dim === "tender") return TENDER_LABELS[key] ?? key;
  // Order-type labels already come human-readable from dim_order_type.
  return key;
}

export interface ShareSlice {
  key: string;
  label: string;
  value_cents: number;
  count: number;
  /** Fraction 0..1 of the dimension's total value. 0 when the period has no value. */
  share: number;
}

/** Map raw breakdown rows to labeled slices with each segment's share of the total. */
export function toShares(dim: SegmentDim, rows: BreakdownRow[]): ShareSlice[] {
  const total = rows.reduce((sum, row) => sum + row.value_cents, 0);
  return rows.map((row) => ({
    key: row.key,
    label: segmentLabel(dim, row.key),
    value_cents: row.value_cents,
    count: row.count,
    share: total > 0 ? row.value_cents / total : 0,
  }));
}
