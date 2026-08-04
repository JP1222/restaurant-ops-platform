import {
  resolveMetric,
  type MetricRegistry,
  type MetricUnit,
  type MetricWindow,
} from "./metric-registry.js";
import type { DbPool } from "../db.js";

/**
 * Statistical insight layer (Phase 5) over the governed metric registry
 * (ADR-0030). Turns a metric's OWN recent history into a robust answer to "is
 * this day unusual?" — a percentile rank plus a median/MAD modified z-score — so
 * the AI (and dashboards) ground anomaly claims in statistics instead of the
 * fixed thresholds the audit flagged. It reuses resolveMetric (the same vetted
 * SQL the numbers come from), so every figure here still traces to the registry.
 *
 * Robust-first by design: restaurant daily data is spiky, and a single catering
 * day or holiday inflates a mean/stdDev band enough to hide a real anomaly. The
 * median/MAD modified z-score (Iglewicz-Hoaglin) can't be dragged by one spike;
 * the percentile rank is non-parametric. Classic mean/stdDev rides along for
 * context and as the fallback when the baseline is perfectly flat (MAD = 0).
 */

// Minimum baseline days for a trustworthy distribution. Below this the spread is
// too noisy to call something an anomaly, so we return insufficientData rather
// than a confident-but-meaningless verdict.
export const MIN_BASELINE_DAYS = 7;

// Iglewicz-Hoaglin: |modified z| > 3.5 flags an outlier.
export const MODIFIED_Z_ANOMALY = 3.5;
// Fallback cutoff for classic z, used only when MAD = 0 but stdDev is not.
const Z_ANOMALY = 3;

export interface MetricStats {
  /** Baseline sample size (days, excluding the as-of day). */
  n: number;
  median: number;
  /** Median absolute deviation — the robust spread. */
  mad: number;
  mean: number;
  stdDev: number;
  /** Robust z = 0.6745·(x − median) / MAD; null when MAD = 0. */
  modifiedZ: number | null;
  /** Classic z = (x − mean) / stdDev; null when stdDev = 0. */
  zScore: number | null;
  /** Share of baseline days <= the as-of value, in [0,1]. */
  percentile: number;
  isAnomaly: boolean;
  direction: "high" | "low" | "normal";
}

/** Median of a PRE-SORTED ascending array. */
function medianOfSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Pure: position `current` within its historical `baseline` (must be non-empty).
 * Robust-first (median/MAD), with a mean/stdDev fallback when MAD = 0.
 */
export function computeMetricStats(baseline: number[], current: number): MetricStats {
  const n = baseline.length;
  const sorted = [...baseline].sort((a, b) => a - b);
  const med = medianOfSorted(sorted);
  const mad = medianOfSorted(baseline.map((x) => Math.abs(x - med)).sort((a, b) => a - b));
  const mean = baseline.reduce((sum, x) => sum + x, 0) / n;
  const variance = baseline.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  const modifiedZ = mad === 0 ? null : (0.6745 * (current - med)) / mad;
  const zScore = stdDev === 0 ? null : (current - mean) / stdDev;
  const percentile = baseline.filter((x) => x <= current).length / n;

  let isAnomaly: boolean;
  if (modifiedZ !== null) {
    isAnomaly = Math.abs(modifiedZ) > MODIFIED_Z_ANOMALY;
  } else if (zScore !== null) {
    isAnomaly = Math.abs(zScore) > Z_ANOMALY;
  } else {
    // Flat baseline (MAD and stdDev both 0): anomalous iff it moved off the line.
    isAnomaly = current !== med;
  }

  const direction: MetricStats["direction"] = !isAnomaly
    ? "normal"
    : current >= med
      ? "high"
      : "low";

  return { n, median: med, mad, mean, stdDev, modifiedZ, zScore, percentile, isAnomaly, direction };
}

export interface MetricStatsPoint {
  business_date: string;
  value: number;
}

export interface MetricStatsResult {
  metric: string;
  label: string;
  unit: MetricUnit;
  definition: string;
  baselineDays: number;
  /** The day under examination: the latest in the window, or the requested as-of. */
  asOf: MetricStatsPoint | null;
  stats: MetricStats | null;
  insufficientData: boolean;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize a business_date cell to an ISO YYYY-MM-DD string. As of the global
 * DATE type parser in db.ts, node-pg returns `date` columns as the raw
 * "YYYY-MM-DD" string, so the string path below is the live one. The Date branch
 * is belt-and-suspenders: a stray JS Date (e.g. a timestamp column, or a future
 * caller bypassing the parser) is reformatted via local Y/M/D getters — never
 * toISOString, which would shift the day for timezones ahead of UTC.
 */
function toISODate(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value);
}

/**
 * Resolve a metric's daily series over `days` and position the as-of day (the
 * latest, or `asOf` if given) against the rest as baseline. `business_date` must
 * be an allowed dimension of the metric (resolveMetric throws otherwise — the
 * cost/sales metrics all allow it).
 */
export async function metricStats(
  pool: DbPool,
  registry: MetricRegistry,
  name: string,
  opts: { merchantId: string; timezone: string; days: number; asOf?: string },
  statementTimeoutMs?: number,
): Promise<MetricStatsResult> {
  const def = registry.get(name);
  if (!def) throw new Error(`unknown metric "${name}"`);

  const window: MetricWindow = { mode: "days", days: opts.days };
  const result = await resolveMetric(
    pool,
    registry,
    name,
    {
      merchantId: opts.merchantId,
      timezone: opts.timezone,
      window,
      dimensions: ["business_date"],
    },
    statementTimeoutMs,
  );

  const series: MetricStatsPoint[] = result.rows
    .map((row) => ({ business_date: toISODate(row.business_date), value: toNumber(row.value) }))
    .filter((point): point is MetricStatsPoint => point.value !== null)
    .sort((a, b) => a.business_date.localeCompare(b.business_date));

  const base = {
    metric: name,
    label: def.label,
    unit: def.unit,
    definition: def.definition,
  };

  if (series.length === 0) {
    return { ...base, baselineDays: 0, asOf: null, stats: null, insufficientData: true };
  }

  const targetIndex = opts.asOf
    ? series.findIndex((point) => point.business_date === opts.asOf)
    : series.length - 1;
  if (targetIndex < 0) {
    return { ...base, baselineDays: 0, asOf: null, stats: null, insufficientData: true };
  }

  const asOf = series[targetIndex]!;
  const baseline = series.filter((_, index) => index !== targetIndex).map((point) => point.value);

  if (baseline.length < MIN_BASELINE_DAYS) {
    return { ...base, baselineDays: baseline.length, asOf, stats: null, insufficientData: true };
  }

  return {
    ...base,
    baselineDays: baseline.length,
    asOf,
    stats: computeMetricStats(baseline, asOf.value),
    insufficientData: false,
  };
}
