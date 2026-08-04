/**
 * Presentation layer for the Cost & Prime Cost dashboard (ADR-0031). The
 * calculation口径 lives server-side in the metric registry (ADR-0030); this file
 * holds only what's inherently a *display* decision: the NRA benchmark bands and
 * the coverage gate.
 */

export type BandTone = "good" | "warn" | "bad";

export interface Band {
  tone: BandTone;
  /** CSS var for foreground/marker. */
  color: string;
  /** CSS var for the soft background pill. */
  bg: string;
  label: string;
  note: string;
}

const BAND_GOOD: Band = {
  tone: "good",
  color: "var(--band-good)",
  bg: "var(--band-good-bg)",
  label: "On target",
  note: "NRA benchmark ≤ 32.4%"
};
const BAND_WARN: Band = {
  tone: "warn",
  color: "var(--band-warn)",
  bg: "var(--band-warn-bg)",
  label: "Watch",
  note: "NRA caution 32.4–35%"
};
const BAND_BAD: Band = {
  tone: "bad",
  color: "var(--band-bad)",
  bg: "var(--band-bad-bg)",
  label: "Over",
  note: "NRA over > 35%"
};

// NRA limited-service food-cost bands: green <= 32.4%, amber 32.4-35%, red > 35%.
const FOOD_BANDS: { max: number; band: Band }[] = [
  { max: 0.324, band: BAND_GOOD },
  { max: 0.35, band: BAND_WARN },
  { max: Number.POSITIVE_INFINITY, band: BAND_BAD }
];

/**
 * Below this recipe coverage, food cost % is a FLOOR, not a verdict — so the
 * dashboard suppresses the green/amber/red band rather than show a
 * misleadingly-low "green" while the catalog is half-costed. This is the口径
 * decision (canonical net-sales denominator + band gated on coverage), the
 * aggregate form of the never-$0 invariant.
 */
export const COVERAGE_GATE = 0.9;

export interface FoodCostBandResult {
  /** The resolved band, or null when gated (coverage below the threshold). */
  band: Band | null;
  /** True when the band is suppressed because coverage is too low to trust it. */
  gated: boolean;
}

export function evalFoodBand(
  value: number | null,
  coverage: number | null
): FoodCostBandResult {
  if (value == null) return { band: null, gated: false };
  if (coverage != null && coverage < COVERAGE_GATE) {
    return { band: null, gated: true };
  }
  const match = FOOD_BANDS.find((b) => value <= b.max) ?? BAND_BAD;
  return { band: "band" in match ? match.band : match, gated: false };
}

// NRA limited-service labor cost runs ~25-35% of sales. NOT coverage-gated:
// labor is not recipe-derived, so recipe completeness has no bearing on it.
const LABOR_GOOD: Band = {
  tone: "good",
  color: "var(--band-good)",
  bg: "var(--band-good-bg)",
  label: "On target",
  note: "NRA ~25-30%"
};
const LABOR_WARN: Band = {
  tone: "warn",
  color: "var(--band-warn)",
  bg: "var(--band-warn-bg)",
  label: "Watch",
  note: "NRA caution 30-35%"
};
const LABOR_BAD: Band = {
  tone: "bad",
  color: "var(--band-bad)",
  bg: "var(--band-bad-bg)",
  label: "High",
  note: "NRA over > 35%"
};

const LABOR_BANDS: { max: number; band: Band }[] = [
  { max: 0.3, band: LABOR_GOOD },
  { max: 0.35, band: LABOR_WARN },
  { max: Number.POSITIVE_INFINITY, band: LABOR_BAD }
];

export function evalLaborBand(value: number | null): Band | null {
  if (value == null) return null;
  const match = LABOR_BANDS.find((b) => value <= b.max);
  return match ? match.band : LABOR_BAD;
}

// NRA limited-service prime cost target is <= 65% of sales. Prime contains the
// food leg, so it inherits food's coverage caveat: the band is gated on coverage
// exactly like food cost % -- a half-costed catalog understates prime too.
const PRIME_GOOD: Band = {
  tone: "good",
  color: "var(--band-good)",
  bg: "var(--band-good-bg)",
  label: "On target",
  note: "NRA target <= 65%"
};
const PRIME_WARN: Band = {
  tone: "warn",
  color: "var(--band-warn)",
  bg: "var(--band-warn-bg)",
  label: "Watch",
  note: "NRA caution 65-70%"
};
const PRIME_BAD: Band = {
  tone: "bad",
  color: "var(--band-bad)",
  bg: "var(--band-bad-bg)",
  label: "Over",
  note: "NRA over > 70%"
};

const PRIME_BANDS: { max: number; band: Band }[] = [
  { max: 0.65, band: PRIME_GOOD },
  { max: 0.7, band: PRIME_WARN },
  { max: Number.POSITIVE_INFINITY, band: PRIME_BAD }
];

export function evalPrimeBand(
  value: number | null,
  coverage: number | null
): FoodCostBandResult {
  if (value == null) return { band: null, gated: false };
  if (coverage != null && coverage < COVERAGE_GATE) {
    return { band: null, gated: true };
  }
  const match = PRIME_BANDS.find((b) => value <= b.max);
  return { band: match ? match.band : PRIME_BAD, gated: false };
}

// NRA target ceilings (the green-band max) — the reference line each card shows a
// signed variance against, so an operator reads actual + target + variance at a glance
// (the limited-service flash-report convention), not just a color. Labor has no
// methodology-solid public median in our corpus (ADR-0033), so the labor card shows no
// target line.
export const FOOD_TARGET = 0.324;
export const PRIME_TARGET = 0.65;

/**
 * Signed points-vs-target readout, e.g. "+3.6 pts vs 32.4% target" (over) or
 * "-1.2 pts vs 32.4% target" (under). A bare "0.0 pts" reads as on-target.
 */
export function targetVarianceLabel(value: number, target: number): string {
  const deltaPts = (value - target) * 100;
  const sign = deltaPts > 0 ? "+" : deltaPts < 0 ? "-" : "";
  const targetPct = (target * 100).toFixed(1);
  return `${sign}${Math.abs(deltaPts).toFixed(1)} pts vs ${targetPct}% target`;
}

export type MetricSource = "POS" | "Analytics" | "Inventory" | "Config";

export const METRIC_SOURCE: Record<string, MetricSource> = {
  net_sales_cents: "POS",
  food_cost_cents: "Analytics",
  food_cost_pct: "Analytics",
  gross_margin_pct: "Analytics",
  cost_coverage_pct: "Analytics"
};

/** Order the registry-backed metrics appear in the provenance table. */
export const REAL_PROVENANCE_ORDER = [
  "net_sales_cents",
  "food_cost_cents",
  "food_cost_pct",
  "cost_coverage_pct",
  "gross_margin_pct"
];

export interface DeferredMetric {
  id: string;
  label: string;
  definition: string;
  source: MetricSource;
  status: "not_connected" | "partial";
}

/**
 * Metrics the design surfaces that depend on data not yet ingested. They render
 * as honest "not connected" / "partial" states — never a fabricated number.
 */
export const DEFERRED_METRICS: DeferredMetric[] = [
  {
    id: "labor_cost_pct",
    label: "Labor cost %",
    definition: "Configured labor cost ÷ net sales",
    source: "Config",
    status: "not_connected"
  },
  {
    id: "prime_cost_pct",
    label: "Prime cost %",
    definition: "Food cost % + labor cost %",
    source: "Analytics",
    status: "partial"
  },
  {
    id: "actual_cogs_cents",
    label: "Actual COGS",
    definition: "Beginning + received − ending inventory (counted)",
    source: "Inventory",
    status: "not_connected"
  },
  {
    id: "yield_variance_cents",
    label: "Yield variance",
    definition: "Actual COGS − theoretical COGS",
    source: "Inventory",
    status: "not_connected"
  }
];
