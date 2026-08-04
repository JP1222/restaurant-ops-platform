import { describe, expect, it } from "vitest";

import {
  clampOnHand,
  computeCountVariance,
  isWasteApproved,
  round2
} from "../src/domain/inventory.js";

const settings = { photo_required_over_cents: 2500, manager_approval_over_cents: 5000 };

describe("isWasteApproved", () => {
  it("auto-approves below the manager threshold", () => {
    expect(isWasteApproved(4999, settings)).toBe(true);
  });

  it("requires sign-off at or above the threshold", () => {
    expect(isWasteApproved(5000, settings)).toBe(false);
    expect(isWasteApproved(8000, settings)).toBe(false);
  });
});

describe("clampOnHand", () => {
  it("never goes negative", () => {
    expect(clampOnHand(-3)).toBe(0);
  });

  it("rounds to 2 decimals", () => {
    expect(clampOnHand(2.346)).toBe(2.35);
  });
});

describe("round2", () => {
  it("rounds to 2 decimals", () => {
    expect(round2(1.236)).toBe(1.24);
    expect(round2(1.234)).toBe(1.23);
  });
});

describe("computeCountVariance", () => {
  it("computes the dollar and percent variance over counted lines", () => {
    const variance = computeCountVariance([
      { costCents: 100, before: 10, after: 8 },
      { costCents: 50, before: 4, after: 5 }
    ]);
    expect(variance.items).toBe(2);
    expect(variance.varianceCents).toBe(-150);
    expect(variance.variancePct).toBe(-12.5);
  });

  it("returns a null percent when there is no prior book value", () => {
    const variance = computeCountVariance([{ costCents: 100, before: 0, after: 5 }]);
    expect(variance.varianceCents).toBe(500);
    expect(variance.variancePct).toBeNull();
  });

  it("handles empty input", () => {
    expect(computeCountVariance([])).toEqual({ items: 0, varianceCents: 0, variancePct: null });
  });
});
