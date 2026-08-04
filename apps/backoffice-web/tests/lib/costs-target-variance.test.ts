import { describe, expect, it } from "vitest";
import { FOOD_TARGET, PRIME_TARGET, targetVarianceLabel } from "@/lib/costs/bands";

describe("targetVarianceLabel", () => {
  it("shows a +signed delta when over target", () => {
    expect(targetVarianceLabel(0.36, FOOD_TARGET)).toBe("+3.6 pts vs 32.4% target");
  });

  it("shows a -signed delta when under target", () => {
    expect(targetVarianceLabel(0.3, FOOD_TARGET)).toBe("-2.4 pts vs 32.4% target");
  });

  it("reads as on-target at exactly the target", () => {
    expect(targetVarianceLabel(0.65, PRIME_TARGET)).toBe("0.0 pts vs 65.0% target");
  });
});
