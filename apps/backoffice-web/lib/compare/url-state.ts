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

export interface CompareFilters {
  primary_from: string;
  primary_to: string;
  compare_from: string;
  compare_to: string;
  metric: TrendMetric;
  grain: TrendGranularity;
}

export interface ComparePreset {
  id: "wow" | "30d" | "mom";
  label: string;
  apply: (
    now?: DateTime,
  ) => Pick<CompareFilters, "primary_from" | "primary_to" | "compare_from" | "compare_to">;
}

function toISODate(date: DateTime): string {
  return date.toFormat("yyyy-MM-dd");
}

function isISODate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;

  const parsed = DateTime.fromISO(value, { zone: STORE_TZ });
  return parsed.isValid && toISODate(parsed) === value;
}

export function defaultCompareFilters(now = DateTime.now().setZone(STORE_TZ)): CompareFilters {
  const today = now.setZone(STORE_TZ).startOf("day");

  return {
    primary_from: toISODate(today.minus({ days: 6 })),
    primary_to: toISODate(today),
    compare_from: toISODate(today.minus({ days: 13 })),
    compare_to: toISODate(today.minus({ days: 7 })),
    metric: "net_sales",
    grain: "day",
  };
}

export function parseCompareFilters(searchParams: URLSearchParams): CompareFilters {
  const defaults = defaultCompareFilters();
  const metric = searchParams.get("metric");
  const grain = searchParams.get("grain");
  const parsed: CompareFilters = {
    primary_from: parseDateParam(searchParams, "primary_from", defaults.primary_from),
    primary_to: parseDateParam(searchParams, "primary_to", defaults.primary_to),
    compare_from: parseDateParam(searchParams, "compare_from", defaults.compare_from),
    compare_to: parseDateParam(searchParams, "compare_to", defaults.compare_to),
    metric:
      metric && VALID_METRICS.includes(metric as TrendMetric)
        ? (metric as TrendMetric)
        : defaults.metric,
    grain:
      grain && VALID_GRAINS.includes(grain as TrendGranularity)
        ? (grain as TrendGranularity)
        : defaults.grain,
  };

  if (parsed.primary_from > parsed.primary_to) {
    parsed.primary_from = defaults.primary_from;
    parsed.primary_to = defaults.primary_to;
  }

  if (parsed.compare_from > parsed.compare_to) {
    parsed.compare_from = defaults.compare_from;
    parsed.compare_to = defaults.compare_to;
  }

  return parsed;
}

function parseDateParam(
  searchParams: URLSearchParams,
  key: keyof CompareFilters,
  fallback: string,
): string {
  const value = searchParams.get(key);
  return value && isISODate(value) ? value : fallback;
}

export function serializeCompareFilters(filters: CompareFilters): URLSearchParams {
  return new URLSearchParams({
    primary_from: filters.primary_from,
    primary_to: filters.primary_to,
    compare_from: filters.compare_from,
    compare_to: filters.compare_to,
    metric: filters.metric,
    grain: filters.grain,
  });
}

export const COMPARE_PRESETS: ComparePreset[] = [
  {
    id: "wow",
    label: "This week vs Last week",
    apply: (now = DateTime.now().setZone(STORE_TZ)) => {
      const today = now.setZone(STORE_TZ).startOf("day");

      return {
        primary_from: toISODate(today.minus({ days: 6 })),
        primary_to: toISODate(today),
        compare_from: toISODate(today.minus({ days: 13 })),
        compare_to: toISODate(today.minus({ days: 7 })),
      };
    },
  },
  {
    id: "30d",
    label: "Last 30 days vs Prior 30 days",
    apply: (now = DateTime.now().setZone(STORE_TZ)) => {
      const today = now.setZone(STORE_TZ).startOf("day");

      return {
        primary_from: toISODate(today.minus({ days: 29 })),
        primary_to: toISODate(today),
        compare_from: toISODate(today.minus({ days: 59 })),
        compare_to: toISODate(today.minus({ days: 30 })),
      };
    },
  },
  {
    id: "mom",
    label: "This month vs Last month",
    apply: (now = DateTime.now().setZone(STORE_TZ)) => {
      const today = now.setZone(STORE_TZ).startOf("day");
      const thisMonthStart = today.startOf("month");
      const lastMonthStart = thisMonthStart.minus({ months: 1 });

      return {
        primary_from: toISODate(thisMonthStart),
        primary_to: toISODate(today),
        compare_from: toISODate(lastMonthStart),
        compare_to: toISODate(thisMonthStart.minus({ days: 1 })),
      };
    },
  },
];
