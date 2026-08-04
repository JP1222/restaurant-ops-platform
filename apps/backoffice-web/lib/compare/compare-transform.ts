import type {
  TrendGranularity,
  TrendMetric,
  TrendPoint,
  TrendsView,
} from "@/lib/analytics-api/trends-transform";

export type CompareChartKind = "bar" | "line";

export interface ComparePoint {
  position_label: string;
  position_index: number;
  primary_value: number | null;
  primary_date: string | null;
  compare_value: number | null;
  compare_date: string | null;
  diff: number | null;
  diff_pct: number | null;
}

export interface CompareView {
  metric: TrendMetric;
  granularity: TrendGranularity;
  primary_range: { from: string; to: string };
  compare_range: { from: string; to: string };
  points: ComparePoint[];
  chart_kind: CompareChartKind;
  totals: {
    primary_value: number;
    compare_value: number;
    diff: number;
    diff_pct: number | null;
  };
}

function pointValue(point: TrendPoint | undefined): number | null {
  return point ? point.value : null;
}

export function transformToCompare(primary: TrendsView, compare: TrendsView): CompareView {
  if (primary.metric !== compare.metric) {
    throw new Error(`metric mismatch: primary=${primary.metric} compare=${compare.metric}`);
  }

  if (primary.granularity !== compare.granularity) {
    throw new Error(
      `granularity mismatch: primary=${primary.granularity} compare=${compare.granularity}`,
    );
  }

  const length = Math.max(primary.points.length, compare.points.length);
  const labelPrefix = primary.granularity === "week" ? "Week" : "Day";
  let primarySum = 0;
  let compareSum = 0;

  const points = Array.from({ length }, (_, index) => {
    const primaryPoint = primary.points[index];
    const comparePoint = compare.points[index];
    const primaryValue = pointValue(primaryPoint);
    const compareValue = pointValue(comparePoint);
    const hasBoth = primaryValue !== null && compareValue !== null;
    const diff = hasBoth ? primaryValue - compareValue : null;
    const diffPct = hasBoth && compareValue !== 0 ? ((primaryValue - compareValue) / compareValue) * 100 : null;

    if (hasBoth) {
      primarySum += primaryValue;
      compareSum += compareValue;
    }

    return {
      position_label: `${labelPrefix} ${index + 1}`,
      position_index: index + 1,
      primary_value: primaryValue,
      primary_date: primaryPoint?.bucket_start ?? null,
      compare_value: compareValue,
      compare_date: comparePoint?.bucket_start ?? null,
      diff,
      diff_pct: diffPct,
    };
  });

  const diff = primarySum - compareSum;

  return {
    metric: primary.metric,
    granularity: primary.granularity,
    primary_range: { from: primary.from, to: primary.to },
    compare_range: { from: compare.from, to: compare.to },
    points,
    chart_kind: points.length <= 30 ? "bar" : "line",
    totals: {
      primary_value: primarySum,
      compare_value: compareSum,
      diff,
      diff_pct: compareSum === 0 ? null : (diff / compareSum) * 100,
    },
  };
}
