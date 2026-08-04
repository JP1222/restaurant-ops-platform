import { describe, expect, it } from "vitest";

import { crossedBelowPar } from "../src/lib/inventory-store.js";

// The low-stock producer (Phase 5c) fires only on the downward crossing of an
// item's minimum par — once, not on every subsequent drop while already low.
describe("crossedBelowPar", () => {
  it("fires when stock drops from at-or-above par to below it", () => {
    expect(crossedBelowPar(10, 4, 5)).toBe(true); // above -> below
    expect(crossedBelowPar(5, 4, 5)).toBe(true); // exactly at par -> below
  });

  it("does not fire when the item was already below par (no re-cross / spam)", () => {
    expect(crossedBelowPar(4, 2, 5)).toBe(false);
  });

  it("does not fire when stock stays at or above par", () => {
    expect(crossedBelowPar(10, 8, 5)).toBe(false); // still above
    expect(crossedBelowPar(10, 5, 5)).toBe(false); // lands exactly at par (not below)
  });

  it("never fires when no par is set (parMin <= 0)", () => {
    expect(crossedBelowPar(10, 0, 0)).toBe(false);
    expect(crossedBelowPar(10, 0, -1)).toBe(false);
  });
});
