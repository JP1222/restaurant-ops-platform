import { DateTime } from "luxon";
import type { DailySalesRow } from "./types";

const STORE_TZ = "America/Chicago";

export type TrendMetric = "net_sales" | "orders" | "avg_ticket" | "refund_rate" | "discounts";
export type TrendGranularity = "day" | "week";

export interface TrendPoint {
  bucket_start: string;
  value: number;
  order_count: number;
  net_sales_cents: number;
}

export interface TrendsView {
  metric: TrendMetric;
  granularity: TrendGranularity;
  from: string;
  to: string;
  points: TrendPoint[];
  totals: {
    net_sales_cents: number;
    order_count: number;
    refund_total_cents: number;
    discount_total_cents: number;
  };
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Ratio metrics mirror the governed metric registry's aggregate definitions
// (ADR-0030), so Trends agrees with Today and the AI: avg_ticket = net / orders;
// refund_rate = refund / payment_total (NOT refund / net_sales). Both are
// sum-over-sum, so they apply unchanged at day and week grain. Trends buckets
// arbitrary date ranges, so it computes these from bucket totals rather than
// reading the per-day resolved fields (ratios can't be re-aggregated).
function pickMetric(
  metric: TrendMetric,
  netSalesCents: number,
  orderCount: number,
  refundTotalCents: number,
  paymentTotalCents: number,
  discountTotalCents: number,
): number {
  if (metric === "net_sales") return netSalesCents;
  if (metric === "orders") return orderCount;
  if (metric === "avg_ticket") return orderCount > 0 ? netSalesCents / orderCount : 0;
  if (metric === "refund_rate") return paymentTotalCents > 0 ? refundTotalCents / paymentTotalCents : 0;
  if (metric === "discounts") return discountTotalCents;
  return 0;
}

function weekStart(businessDate: string): string {
  return DateTime.fromISO(businessDate, { zone: STORE_TZ }).startOf("week").toFormat("yyyy-MM-dd");
}

export function transformToTrends(
  rows: DailySalesRow[],
  metric: TrendMetric,
  granularity: TrendGranularity,
  from: string,
  to: string,
): TrendsView {
  const sorted = rows
    .filter((row) => row.business_date >= from && row.business_date <= to)
    .sort((a, b) =>
      a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0,
    );

  const totals = sorted.reduce(
    (acc, row) => ({
      net_sales_cents: acc.net_sales_cents + toNumber(row.net_sales_cents),
      order_count: acc.order_count + toNumber(row.order_count),
      refund_total_cents: acc.refund_total_cents + toNumber(row.refund_total_cents),
      discount_total_cents: acc.discount_total_cents + toNumber(row.discount_total_cents),
    }),
    { net_sales_cents: 0, order_count: 0, refund_total_cents: 0, discount_total_cents: 0 },
  );

  if (granularity === "day") {
    return {
      metric,
      granularity,
      from,
      to,
      points: sorted.map((row) => {
        const netSalesCents = toNumber(row.net_sales_cents);
        const orderCount = toNumber(row.order_count);
        const refundTotalCents = toNumber(row.refund_total_cents);
        const paymentTotalCents = toNumber(row.payment_total_cents);
        const discountTotalCents = toNumber(row.discount_total_cents);

        return {
          bucket_start: row.business_date,
          value: pickMetric(
            metric,
            netSalesCents,
            orderCount,
            refundTotalCents,
            paymentTotalCents,
            discountTotalCents,
          ),
          order_count: orderCount,
          net_sales_cents: netSalesCents,
        };
      }),
      totals,
    };
  }

  const byWeek = new Map<
    string,
    {
      netSalesCents: number;
      orderCount: number;
      refundTotalCents: number;
      paymentTotalCents: number;
      discountTotalCents: number;
    }
  >();
  for (const row of sorted) {
    const key = weekStart(row.business_date);
    const acc = byWeek.get(key) ?? {
      netSalesCents: 0,
      orderCount: 0,
      refundTotalCents: 0,
      paymentTotalCents: 0,
      discountTotalCents: 0,
    };

    acc.netSalesCents += toNumber(row.net_sales_cents);
    acc.orderCount += toNumber(row.order_count);
    acc.refundTotalCents += toNumber(row.refund_total_cents);
    acc.paymentTotalCents += toNumber(row.payment_total_cents);
    acc.discountTotalCents += toNumber(row.discount_total_cents);
    byWeek.set(key, acc);
  }

  return {
    metric,
    granularity,
    from,
    to,
    points: Array.from(byWeek.entries())
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([bucketStart, acc]) => ({
        bucket_start: bucketStart,
        value: pickMetric(
          metric,
          acc.netSalesCents,
          acc.orderCount,
          acc.refundTotalCents,
          acc.paymentTotalCents,
          acc.discountTotalCents,
        ),
        order_count: acc.orderCount,
        net_sales_cents: acc.netSalesCents,
      })),
    totals,
  };
}
