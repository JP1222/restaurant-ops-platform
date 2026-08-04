import { DateTime } from "luxon";
import type { TrendGranularity, TrendMetric } from "@/lib/analytics-api/trends-transform";

const STORE_TZ = "America/Chicago";
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_METRICS = [
  "net_sales",
  "orders",
  "avg_ticket",
  "refund_rate",
  "discounts",
] satisfies TrendMetric[];
const VALID_GRAINS = ["day", "week"] satisfies TrendGranularity[];

export interface TrendsFilters {
  from: string;
  to: string;
  metric: TrendMetric;
  grain: TrendGranularity;
}

function isISODate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;

  const parsed = DateTime.fromISO(value, { zone: STORE_TZ });
  return parsed.isValid && parsed.toFormat("yyyy-MM-dd") === value;
}

function defaultFilters(): TrendsFilters {
  const today = DateTime.now().setZone(STORE_TZ);

  return {
    from: today.minus({ days: 29 }).toFormat("yyyy-MM-dd"),
    to: today.toFormat("yyyy-MM-dd"),
    metric: "net_sales",
    grain: "day",
  };
}

export function parseTrendsFilters(searchParams: URLSearchParams): TrendsFilters {
  const defaults = defaultFilters();
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const metric = searchParams.get("metric");
  const grain = searchParams.get("grain");
  const parsed = {
    from: from && isISODate(from) ? from : defaults.from,
    to: to && isISODate(to) ? to : defaults.to,
    metric:
      metric && VALID_METRICS.includes(metric as TrendMetric)
        ? (metric as TrendMetric)
        : defaults.metric,
    grain:
      grain && VALID_GRAINS.includes(grain as TrendGranularity)
        ? (grain as TrendGranularity)
        : defaults.grain,
  };

  if (parsed.from > parsed.to) {
    return defaults;
  }

  return parsed;
}

export function serializeTrendsFilters(filters: TrendsFilters): URLSearchParams {
  return new URLSearchParams({
    from: filters.from,
    to: filters.to,
    metric: filters.metric,
    grain: filters.grain,
  });
}
