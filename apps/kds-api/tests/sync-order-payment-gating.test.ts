import { describe, expect, it } from "vitest";
import { shouldSkipForUnpaidState } from "../src/lib/sync-order.js";

describe("shouldSkipForUnpaidState", () => {
  it("does not skip Clover orders with paymentState 'PAID' (uppercase)", () => {
    expect(shouldSkipForUnpaidState("clover", "PAID")).toBe(false);
  });

  it("does not skip Clover orders with paymentState 'Paid' (mixed case)", () => {
    expect(shouldSkipForUnpaidState("clover", "Paid")).toBe(false);
  });

  it("does not skip Clover orders with paymentState 'paid' (lowercase)", () => {
    expect(shouldSkipForUnpaidState("clover", "paid")).toBe(false);
  });

  it("skips Clover orders with unpaid states regardless of case", () => {
    expect(shouldSkipForUnpaidState("clover", "OPEN")).toBe(true);
    expect(shouldSkipForUnpaidState("clover", "Open")).toBe(true);
    expect(shouldSkipForUnpaidState("clover", "open")).toBe(true);
    expect(shouldSkipForUnpaidState("clover", "OPEN_TENDER")).toBe(true);
    expect(shouldSkipForUnpaidState("clover", "LOCKED")).toBe(true);
    expect(shouldSkipForUnpaidState("clover", "Locked")).toBe(true);
    expect(shouldSkipForUnpaidState("clover", "PARTIALLY_PAID")).toBe(true);
  });

  it("does not skip refunded/partially-refunded states (paid-with-history)", () => {
    expect(shouldSkipForUnpaidState("clover", "REFUNDED")).toBe(false);
    expect(shouldSkipForUnpaidState("clover", "PARTIALLY_REFUNDED")).toBe(false);
    expect(shouldSkipForUnpaidState("clover", "Refunded")).toBe(false);
  });

  it("does not skip unknown future paymentState values (safe default)", () => {
    expect(shouldSkipForUnpaidState("clover", "SOME_NEW_STATE")).toBe(false);
  });

  it("does not skip Clover orders with null/empty paymentState", () => {
    expect(shouldSkipForUnpaidState("clover", null)).toBe(false);
    expect(shouldSkipForUnpaidState("clover", "")).toBe(false);
  });

  it("never skips Deliverect orders regardless of paymentState", () => {
    expect(shouldSkipForUnpaidState("deliverect", null)).toBe(false);
    expect(shouldSkipForUnpaidState("deliverect", "OPEN")).toBe(false);
    expect(shouldSkipForUnpaidState("deliverect", "PAID")).toBe(false);
  });

  it("never skips demo orders regardless of paymentState", () => {
    expect(shouldSkipForUnpaidState("demo", "PAID")).toBe(false);
    expect(shouldSkipForUnpaidState("demo", "OPEN")).toBe(false);
    expect(shouldSkipForUnpaidState("demo", null)).toBe(false);
  });

  it("keeps a PAID Square order on the board, skips anything else (fail closed)", () => {
    // normalize-square-order sets paymentState to "PAID" iff net_amount_due == 0.
    expect(shouldSkipForUnpaidState("square", "PAID")).toBe(false);
    expect(shouldSkipForUnpaidState("square", "UNPAID")).toBe(true);
    expect(shouldSkipForUnpaidState("square", null)).toBe(true);
    expect(shouldSkipForUnpaidState("square", "")).toBe(true);
  });
});
