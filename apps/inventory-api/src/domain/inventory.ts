import type { InventoryWasteSettings } from "@rop/contracts";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clampOnHand(n: number): number {
  return Math.max(0, round2(n));
}

// Waste auto-approves below the manager threshold; at or above needs sign-off.
// Mirrors the rule the backoffice prototype applied client-side.
export function isWasteApproved(costCents: number, settings: InventoryWasteSettings): boolean {
  return costCents < settings.manager_approval_over_cents;
}

export interface CountVarianceInput {
  costCents: number;
  before: number;
  after: number;
}

export interface CountVariance {
  items: number;
  varianceCents: number;
  variancePct: number | null;
}

// Variance of a recount: the dollar delta of (after - before) * unit cost across
// the counted lines, plus that delta as a percent of their prior book value.
// Null pct when there is no prior book value to divide by.
export function computeCountVariance(inputs: CountVarianceInput[]): CountVariance {
  let varianceCents = 0;
  let bookValueCents = 0;
  for (const { costCents, before, after } of inputs) {
    varianceCents += Math.round((after - before) * costCents);
    bookValueCents += before * costCents;
  }
  const variancePct = bookValueCents > 0 ? round2((varianceCents / bookValueCents) * 100) : null;
  return { items: inputs.length, varianceCents, variancePct };
}
