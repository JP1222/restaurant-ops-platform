import type { MenuQuadrant } from "@rop/contracts";
import type { MenuEngineeringInputRow } from "@/lib/analytics-api/types";

/**
 * Kasavana-Smith menu-engineering classifier (ADR-0031).
 *
 * Classifies each menu item on PROFITABILITY, not revenue. Two axes:
 *   X = menu mix       — this item's share of units sold (among costed items)
 *   Y = contribution $ — realized unit price minus plate cost
 *
 * Split lines:
 *   X threshold = (1 / N) * popFactor, N = number of costed ("active") items.
 *                 The canonical "70% rule": an item is popular if it beats
 *                 popFactor of its equal share of the menu mix.
 *   Y threshold = units-weighted average contribution margin. A cheap item
 *                 selling in huge volume should raise the profitability bar
 *                 more than a pricey item selling a handful.
 *
 * Items with no plate cost (no recipe on file) are EXCLUDED from the matrix
 * and surfaced separately. Missing cost is never coerced to $0 — that would
 * falsely mark a high-price item a Star (invariant #6). Classification runs
 * client-side so the popularity-factor control recomputes without a refetch.
 */

export const POP_FACTOR_DEFAULT = 0.7;
export const POP_FACTOR_MIN = 0.5;
export const POP_FACTOR_MAX = 1;

export interface MenuEngineeringItem {
  clover_item_id: string | null;
  item_fingerprint: string;
  item_name: string;
  units: number;
  /** Realized gross sales over the window (sum), in cents. */
  revenue_cents: number;
  /** Realized average unit price (revenue / units), in cents. */
  unit_price_cents: number;
  /** Per-unit plate cost from the recipe, in cents (known for active items). */
  plate_cost_cents: number;
  /** Per-unit contribution margin (unit_price - plate_cost), in cents. */
  margin_cents: number;
  /** margin_cents / unit_price_cents, as a 0..1 fraction. */
  margin_pct: number;
  /** units / total active units, as a 0..1 fraction (the X axis). */
  mix: number;
  /** margin_cents * units — total dollars this item contributes. */
  contribution_cents: number;
  /** 1 = highest contribution dollars. */
  rank: number;
  quadrant: MenuQuadrant;
}

export interface CostUnknownItem {
  clover_item_id: string | null;
  item_fingerprint: string;
  item_name: string;
  units: number;
  revenue_cents: number;
  unit_price_cents: number;
}

export interface QuadrantCounts {
  star: number;
  plowhorse: number;
  puzzle: number;
  dog: number;
}

export interface MenuEngineeringView {
  windowDays: number;
  popFactor: number;
  /** N — number of costed items placed in the matrix. */
  activeCount: number;
  /** Total units among active items (the menu-mix denominator). */
  totalUnits: number;
  /** Popularity split: (1 / N) * popFactor. */
  xThreshold: number;
  /** Profitability split: units-weighted average contribution margin, in cents. */
  yThresholdCents: number;
  totalContributionCents: number;
  counts: QuadrantCounts;
  /** Active items, ranked by contribution dollars (descending). */
  items: MenuEngineeringItem[];
  /** Items excluded from the matrix because they have no plate cost. */
  costUnknown: CostUnknownItem[];
}

export interface ClassifyOptions {
  popFactor: number;
  windowDays: number;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPopFactor(value: number): number {
  if (!Number.isFinite(value)) return POP_FACTOR_DEFAULT;
  return Math.min(POP_FACTOR_MAX, Math.max(POP_FACTOR_MIN, value));
}

/**
 * The four-way quadrant rule. An item at exactly a threshold counts as
 * high/popular (>=), matching the Kasavana-Smith convention.
 */
function quadrantFor(
  marginCents: number,
  mix: number,
  yThresholdCents: number,
  xThreshold: number
): MenuQuadrant {
  const highMargin = marginCents >= yThresholdCents;
  const popular = mix >= xThreshold;
  if (highMargin && popular) return "star";
  if (!highMargin && popular) return "plowhorse";
  if (highMargin && !popular) return "puzzle";
  return "dog";
}

const EMPTY_COUNTS: QuadrantCounts = { star: 0, plowhorse: 0, puzzle: 0, dog: 0 };

export function classifyMenu(
  rows: MenuEngineeringInputRow[],
  { popFactor, windowDays }: ClassifyOptions
): MenuEngineeringView {
  const factor = clampPopFactor(popFactor);

  const costUnknown: CostUnknownItem[] = [];
  const active: Array<{
    row: MenuEngineeringInputRow;
    units: number;
    revenueCents: number;
    unitPriceCents: number;
    plateCostCents: number;
    marginCents: number;
  }> = [];

  for (const row of rows) {
    const units = toNumber(row.units);
    const revenueCents = toNumber(row.gross_sales_cents);
    const unitPriceCents = units > 0 ? revenueCents / units : 0;

    // No plate cost (or zero sales we can't price) -> cost unknown, never $0.
    if (row.plate_cost_cents === null || units <= 0) {
      costUnknown.push({
        clover_item_id: row.clover_item_id,
        item_fingerprint: row.item_fingerprint,
        item_name: row.item_name,
        units,
        revenue_cents: revenueCents,
        unit_price_cents: unitPriceCents
      });
      continue;
    }

    const plateCostCents = toNumber(row.plate_cost_cents);
    active.push({
      row,
      units,
      revenueCents,
      unitPriceCents,
      plateCostCents,
      marginCents: unitPriceCents - plateCostCents
    });
  }

  const activeCount = active.length;
  const totalUnits = active.reduce((sum, a) => sum + a.units, 0);

  if (activeCount === 0 || totalUnits === 0) {
    return {
      windowDays,
      popFactor: factor,
      activeCount,
      totalUnits,
      xThreshold: 0,
      yThresholdCents: 0,
      totalContributionCents: 0,
      counts: { ...EMPTY_COUNTS },
      items: [],
      costUnknown
    };
  }

  const xThreshold = (1 / activeCount) * factor;
  const yThresholdCents =
    active.reduce((sum, a) => sum + a.marginCents * a.units, 0) / totalUnits;

  const items: MenuEngineeringItem[] = active.map((a) => {
    const mix = a.units / totalUnits;
    return {
      clover_item_id: a.row.clover_item_id,
      item_fingerprint: a.row.item_fingerprint,
      item_name: a.row.item_name,
      units: a.units,
      revenue_cents: a.revenueCents,
      unit_price_cents: a.unitPriceCents,
      plate_cost_cents: a.plateCostCents,
      margin_cents: a.marginCents,
      margin_pct: a.unitPriceCents > 0 ? a.marginCents / a.unitPriceCents : 0,
      mix,
      contribution_cents: a.marginCents * a.units,
      rank: 0,
      quadrant: quadrantFor(a.marginCents, mix, yThresholdCents, xThreshold)
    };
  });

  // Rank by contribution dollars (margin * units) — the money the item makes.
  items.sort((a, b) => b.contribution_cents - a.contribution_cents);
  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  const counts: QuadrantCounts = { ...EMPTY_COUNTS };
  let totalContributionCents = 0;
  for (const item of items) {
    counts[item.quadrant] += 1;
    totalContributionCents += item.contribution_cents;
  }

  return {
    windowDays,
    popFactor: factor,
    activeCount,
    totalUnits,
    xThreshold,
    yThresholdCents,
    totalContributionCents,
    counts,
    items,
    costUnknown
  };
}
