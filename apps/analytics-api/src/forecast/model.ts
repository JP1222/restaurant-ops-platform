import { DateTime } from "luxon";

/**
 * Self-built, lightweight demand forecast (ADR-0032 / docs/design/analytics/forecasting.md).
 *
 * Model = a weekday seasonal profile: a future day's forecast is the mean of recent
 * same-weekday actuals, with a prediction band from those samples' spread. This alone
 * is "a respectable daypart/day forecast and fully explainable" (forecasting.md step 1);
 * level/trend smoothing and event overrides are deliberately deferred. Quality is
 * measured by our OWN backtest (MAPE/WAPE on held-out weeks) — never a vendor figure.
 *
 * Everything here is pure (arrays in, arrays out, no DB, no clock) so it is fully
 * unit-testable; the run wrapper (run.ts) does the mart read + table write.
 */

export interface SeriesPoint {
  /** Store-local calendar date, "YYYY-MM-DD". */
  date: string;
  value: number;
}

export interface ForecastPoint {
  target_date: string;
  value: number;
  /** Prediction-interval bounds (lo clamped at 0; a demand metric can't go negative). */
  lo: number;
  hi: number;
}

export interface BacktestResult {
  /** Mean absolute percentage error over held-out days with a non-zero actual. */
  mape: number | null;
  /** Weighted absolute percentage error: Σ|actual−forecast| / Σactual. */
  wape: number | null;
  /** Number of held-out days scored. */
  n: number;
}

// ~80% two-sided prediction interval (z for the 0.9 quantile of the normal).
const PI_Z = 1.2816;
// Most recent same-weekday samples to average — 8 weeks balances seasonality with
// responsiveness to the current level.
const DEFAULT_MAX_SAMPLES_PER_WEEKDAY = 8;

interface WeekdayStat {
  mean: number;
  /** Sample standard deviation (0 when fewer than 2 samples). */
  std: number;
  count: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sampleStd(values: number[], mu: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mu) * (v - mu), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function weekdayOf(date: string): number {
  return DateTime.fromISO(date, { zone: "utc" }).weekday; // 1 (Mon) .. 7 (Sun)
}

/**
 * Per-weekday stats from the most recent `maxSamplesPerWeekday` same-weekday values,
 * plus an overall fallback for weekdays with no samples.
 */
function buildStats(
  history: SeriesPoint[],
  maxSamplesPerWeekday: number,
): { byWeekday: Map<number, WeekdayStat>; overall: WeekdayStat } {
  const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const samples = new Map<number, number[]>();
  for (const point of sorted) {
    const w = weekdayOf(point.date);
    const list = samples.get(w) ?? [];
    list.push(point.value);
    samples.set(w, list);
  }

  const byWeekday = new Map<number, WeekdayStat>();
  for (const [w, all] of samples) {
    const recent = all.slice(-maxSamplesPerWeekday);
    const mu = mean(recent);
    byWeekday.set(w, { mean: mu, std: sampleStd(recent, mu), count: recent.length });
  }

  const allValues = sorted.map((p) => p.value);
  const overallMean = mean(allValues);
  return {
    byWeekday,
    overall: { mean: overallMean, std: sampleStd(allValues, overallMean), count: allValues.length },
  };
}

export interface ForecastOptions {
  maxSamplesPerWeekday?: number;
}

/**
 * Forecast `horizonDays` days past the last history date. Returns one point per future
 * day with a prediction band. Empty when history is empty.
 */
export function weekdaySeasonalForecast(
  history: SeriesPoint[],
  horizonDays: number,
  options: ForecastOptions = {},
): ForecastPoint[] {
  if (history.length === 0 || horizonDays <= 0) return [];

  const maxSamples = options.maxSamplesPerWeekday ?? DEFAULT_MAX_SAMPLES_PER_WEEKDAY;
  const { byWeekday, overall } = buildStats(history, maxSamples);

  const lastDate = history.reduce((max, p) => (p.date > max ? p.date : max), history[0]!.date);
  const anchor = DateTime.fromISO(lastDate, { zone: "utc" });

  const points: ForecastPoint[] = [];
  for (let i = 1; i <= horizonDays; i += 1) {
    const day = anchor.plus({ days: i });
    const w = day.weekday;
    const stat = byWeekday.get(w) ?? overall;
    const value = stat.mean;
    // Fall back to the overall spread when a weekday has too few samples to estimate one.
    const std = stat.count >= 2 ? stat.std : overall.std;
    points.push({
      target_date: day.toISODate()!,
      value,
      lo: Math.max(0, value - PI_Z * std),
      hi: value + PI_Z * std,
    });
  }
  return points;
}

/**
 * Backtest: hold out the last `holdoutDays` days, fit the model on everything before
 * them, predict each held-out day, and score MAPE/WAPE. Returns nulls when there isn't
 * enough history to hold out a window and still train on a non-empty remainder.
 */
export function backtest(
  history: SeriesPoint[],
  holdoutDays: number,
  options: ForecastOptions = {},
): BacktestResult {
  if (history.length === 0 || holdoutDays <= 0) {
    return { mape: null, wape: null, n: 0 };
  }
  const sorted = [...history].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastDate = sorted[sorted.length - 1]!.date;
  const cutoff = DateTime.fromISO(lastDate, { zone: "utc" }).minus({ days: holdoutDays }).toISODate()!;

  const train = sorted.filter((p) => p.date <= cutoff);
  const test = sorted.filter((p) => p.date > cutoff);
  if (train.length === 0 || test.length === 0) {
    return { mape: null, wape: null, n: 0 };
  }

  const maxSamples = options.maxSamplesPerWeekday ?? DEFAULT_MAX_SAMPLES_PER_WEEKDAY;
  const { byWeekday, overall } = buildStats(train, maxSamples);

  let apeSum = 0;
  let apeCount = 0;
  let absErrSum = 0;
  let actualSum = 0;
  for (const point of test) {
    const predicted = (byWeekday.get(weekdayOf(point.date)) ?? overall).mean;
    const absErr = Math.abs(point.value - predicted);
    absErrSum += absErr;
    actualSum += point.value;
    if (point.value > 0) {
      apeSum += absErr / point.value;
      apeCount += 1;
    }
  }

  return {
    mape: apeCount > 0 ? apeSum / apeCount : null,
    wape: actualSum > 0 ? absErrSum / actualSum : null,
    n: test.length,
  };
}
