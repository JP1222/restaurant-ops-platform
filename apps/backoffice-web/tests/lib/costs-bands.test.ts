import { describe, expect, test } from "vitest";
import {
  COVERAGE_GATE,
  evalFoodBand,
  evalLaborBand,
  evalPrimeBand
} from "@/lib/costs/bands";

describe("evalFoodBand", () => {
  const FULL = 0.95; // coverage above the gate

  test("bands food cost % against the NRA thresholds when coverage is high", () => {
    expect(evalFoodBand(0.3, FULL).band?.tone).toBe("good");
    expect(evalFoodBand(0.324, FULL).band?.tone).toBe("good"); // boundary is inclusive
    expect(evalFoodBand(0.34, FULL).band?.tone).toBe("warn");
    expect(evalFoodBand(0.35, FULL).band?.tone).toBe("warn");
    expect(evalFoodBand(0.4, FULL).band?.tone).toBe("bad");
  });

  test("suppresses the band when recipe coverage is below the gate", () => {
    const result = evalFoodBand(0.19, COVERAGE_GATE - 0.01);
    expect(result.gated).toBe(true);
    expect(result.band).toBeNull();
  });

  test("shows the band exactly at the coverage gate", () => {
    const result = evalFoodBand(0.31, COVERAGE_GATE);
    expect(result.gated).toBe(false);
    expect(result.band?.tone).toBe("good");
  });

  test("no value yields no band and is not treated as gated", () => {
    expect(evalFoodBand(null, FULL)).toEqual({ band: null, gated: false });
  });
});

describe("evalLaborBand", () => {
  test("bands labor cost % against the NRA ~25-35% range (never coverage-gated)", () => {
    expect(evalLaborBand(0.25)?.tone).toBe("good");
    expect(evalLaborBand(0.3)?.tone).toBe("good"); // boundary is inclusive
    expect(evalLaborBand(0.32)?.tone).toBe("warn");
    expect(evalLaborBand(0.35)?.tone).toBe("warn");
    expect(evalLaborBand(0.4)?.tone).toBe("bad");
  });

  test("no value yields no band", () => {
    expect(evalLaborBand(null)).toBeNull();
  });
});

describe("evalPrimeBand", () => {
  const FULL = 0.95; // coverage above the gate

  test("bands prime cost % against the NRA <= 65% target when coverage is high", () => {
    expect(evalPrimeBand(0.6, FULL).band?.tone).toBe("good");
    expect(evalPrimeBand(0.65, FULL).band?.tone).toBe("good"); // boundary inclusive
    expect(evalPrimeBand(0.68, FULL).band?.tone).toBe("warn");
    expect(evalPrimeBand(0.75, FULL).band?.tone).toBe("bad");
  });

  test("inherits the coverage gate because prime contains the food leg", () => {
    const result = evalPrimeBand(0.55, COVERAGE_GATE - 0.01);
    expect(result.gated).toBe(true);
    expect(result.band).toBeNull();
  });

  test("no value yields no band and is not treated as gated", () => {
    expect(evalPrimeBand(null, FULL)).toEqual({ band: null, gated: false });
  });
});
