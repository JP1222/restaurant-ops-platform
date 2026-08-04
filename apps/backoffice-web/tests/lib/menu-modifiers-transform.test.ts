import { describe, expect, test } from "vitest";
import { transformMenuModifiers } from "@/lib/analytics-api/menu-modifiers-transform";
import type { ItemModifierRow } from "@/lib/analytics-api/types";

describe("transformMenuModifiers", () => {
  test("coerces string-typed numerics into numbers", () => {
    const input: ItemModifierRow[] = [
      {
        modifier_name: "Extra cheese",
        modifier_count: "12",
        modifier_total_cents: "2400",
        attach_rate: "0.45"
      }
    ];

    const [mod] = transformMenuModifiers(input);
    expect(mod).toBeDefined();
    expect(mod!.modifier_count).toBe(12);
    expect(mod!.modifier_total_cents).toBe(2400);
    expect(mod!.attach_rate).toBe(0.45);
  });

  test("sorts attach_rate DESC with modifier_count DESC as tiebreaker", () => {
    const input: ItemModifierRow[] = [
      { modifier_name: "low", modifier_count: 1, modifier_total_cents: 0, attach_rate: 0.1 },
      { modifier_name: "tie_few", modifier_count: 5, modifier_total_cents: 0, attach_rate: 0.5 },
      { modifier_name: "highest", modifier_count: 100, modifier_total_cents: 0, attach_rate: 0.9 },
      { modifier_name: "tie_many", modifier_count: 50, modifier_total_cents: 0, attach_rate: 0.5 }
    ];

    const sorted = transformMenuModifiers(input);

    expect(sorted.map((m) => m.modifier_name)).toEqual([
      "highest",
      "tie_many",
      "tie_few",
      "low"
    ]);
  });

  test("preserves modifier_name verbatim, including whitespace and unicode", () => {
    const input: ItemModifierRow[] = [
      {
        modifier_name: "  No ñachos cheese  ",
        modifier_count: 1,
        modifier_total_cents: 100,
        attach_rate: 0.2
      },
      {
        modifier_name: "\u{1F31F} Stars",
        modifier_count: 2,
        modifier_total_cents: 50,
        attach_rate: 0.1
      }
    ];

    const sorted = transformMenuModifiers(input);

    expect(sorted.map((m) => m.modifier_name)).toEqual([
      "  No ñachos cheese  ",
      "\u{1F31F} Stars"
    ]);
  });
});
