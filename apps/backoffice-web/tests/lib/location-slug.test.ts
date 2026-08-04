import { describe, expect, test } from "vitest";
import { nextAvailableSlug, slugify } from "@/lib/location/slug";

describe("slugify", () => {
  test("lowercases and kebab-cases a store name", () => {
    expect(slugify("Anytown Mall")).toBe("anytown-mall");
    expect(slugify("  Downtown #2!  ")).toBe("downtown-2");
  });

  test("falls back to 'store' when nothing slug-able remains", () => {
    expect(slugify("!!!")).toBe("store");
    expect(slugify("")).toBe("store");
  });
});

describe("nextAvailableSlug", () => {
  test("returns the base when it is free", () => {
    expect(nextAvailableSlug("anytown", new Set())).toBe("anytown");
  });

  test("appends the first free numeric suffix on collision", () => {
    expect(nextAvailableSlug("anytown", new Set(["anytown"]))).toBe("anytown-2");
    expect(nextAvailableSlug("anytown", new Set(["anytown", "anytown-2"]))).toBe(
      "anytown-3",
    );
  });

  test("returns the lowest free suffix regardless of gaps in the taken set", () => {
    expect(nextAvailableSlug("store", new Set(["store", "store-3"]))).toBe("store-2");
  });
});
