import { describe, expect, it } from "vitest";

import {
  InventoryCategorySchema,
  InventoryCountSubmissionSchema,
  InventoryEmployeeCreateRequestSchema,
  InventoryEmployeePinResetRequestSchema,
  InventoryWasteSubmissionSchema,
  defaultInventoryCategories,
  inventoryCategoryIds,
} from "./inventory.js";

describe("defaultInventoryCategories (cold-start category picker)", () => {
  it("covers every canonical category id exactly once", () => {
    expect(defaultInventoryCategories.map((c) => c.id).sort()).toEqual(
      [...inventoryCategoryIds].sort()
    );
  });

  it("each entry is schema-valid with a non-empty display name and color", () => {
    for (const c of defaultInventoryCategories) {
      expect(InventoryCategorySchema.safeParse(c).success).toBe(true);
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(c.color.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("crew PIN validation", () => {
  // PINs flow through the create + reset request schemas (the inner PIN schema is
  // intentionally not exported). It must be exactly six digits (hardened from 4).
  it("accepts a 6-digit PIN", () => {
    expect(InventoryEmployeePinResetRequestSchema.safeParse({ pin: "042069" }).success).toBe(true);
  });

  it.each(["123", "12345", "1234", "1234567", "12a456", "", "1.3456"])(
    "rejects a non-6-digit PIN: %s",
    (pin) => {
      expect(InventoryEmployeePinResetRequestSchema.safeParse({ pin }).success).toBe(false);
    },
  );

  it("enforces the PIN regex on create as well", () => {
    const base = { name: "Cook", role: "line", shift: "AM" };
    expect(InventoryEmployeeCreateRequestSchema.safeParse({ ...base, pin: "999999" }).success).toBe(
      true,
    );
    expect(InventoryEmployeeCreateRequestSchema.safeParse({ ...base, pin: "9999" }).success).toBe(
      false,
    );
  });
});

describe("InventoryWasteSubmissionSchema", () => {
  function baseWaste() {
    return {
      sku: "SKU1",
      qty: 2,
      reason: "spoilage" as const,
      notes: "soft",
      photo: false,
      cost_cents: 0,
      who: "Cook",
    };
  }

  it("accepts cost_cents of exactly 0", () => {
    expect(InventoryWasteSubmissionSchema.safeParse(baseWaste()).success).toBe(true);
  });

  it("rejects a negative cost_cents", () => {
    expect(
      InventoryWasteSubmissionSchema.safeParse({ ...baseWaste(), cost_cents: -1 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer cost_cents", () => {
    expect(
      InventoryWasteSubmissionSchema.safeParse({ ...baseWaste(), cost_cents: 10.5 }).success,
    ).toBe(false);
  });

  it("rejects a non-positive quantity", () => {
    expect(InventoryWasteSubmissionSchema.safeParse({ ...baseWaste(), qty: 0 }).success).toBe(
      false,
    );
  });

  it("rejects an empty `who` attribution", () => {
    expect(InventoryWasteSubmissionSchema.safeParse({ ...baseWaste(), who: "" }).success).toBe(
      false,
    );
  });
});

describe("InventoryCountSubmissionSchema", () => {
  it("accepts an empty updates record", () => {
    const parsed = InventoryCountSubmissionSchema.parse({ updates: {}, who: "Cook" });
    expect(parsed.updates).toEqual({});
    expect(parsed.scope).toBeUndefined();
  });

  it("accepts a populated updates record keyed by sku", () => {
    const parsed = InventoryCountSubmissionSchema.parse({
      updates: { SKU1: 12, SKU2: 0 },
      who: "Cook",
      scope: "walk-in",
    });
    expect(parsed.updates.SKU1).toBe(12);
    expect(parsed.scope).toBe("walk-in");
  });

  it("rejects a negative count in the updates record", () => {
    expect(
      InventoryCountSubmissionSchema.safeParse({ updates: { SKU1: -3 }, who: "Cook" }).success,
    ).toBe(false);
  });

  it("rejects a missing `who`", () => {
    expect(InventoryCountSubmissionSchema.safeParse({ updates: { SKU1: 1 } }).success).toBe(false);
  });
});
