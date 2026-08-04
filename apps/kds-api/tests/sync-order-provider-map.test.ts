import { orderProviders } from "@rop/contracts";
import { OrderProvider } from "@rop/db-kds";
import { describe, expect, it } from "vitest";

import { dbProviderFrom } from "../src/lib/sync-order.js";

// Guards the contract-provider -> Prisma-enum mapping. The mapper used to
// `default` unknown providers to CLOVER, which would silently mislabel a Square
// order as Clover. These tests pin every contract provider to its enum and prove
// the tuple and the mapper stay in lockstep.
describe("dbProviderFrom", () => {
  it("maps each provider to its Prisma enum value", () => {
    expect(dbProviderFrom("clover")).toBe(OrderProvider.CLOVER);
    expect(dbProviderFrom("deliverect")).toBe(OrderProvider.DELIVERECT);
    expect(dbProviderFrom("demo")).toBe(OrderProvider.DEMO);
    expect(dbProviderFrom("square")).toBe(OrderProvider.SQUARE);
  });

  it("has a mapping for every contract provider (no silent fallthrough)", () => {
    for (const provider of orderProviders) {
      const mapped = dbProviderFrom(provider);
      // Every contract provider must resolve to a real enum member, and the
      // enum value must round-trip to the upper-cased provider name.
      expect(Object.values(OrderProvider)).toContain(mapped);
      expect(mapped).toBe(provider.toUpperCase());
    }
  });
});
