import { describe, expect, it } from "vitest";
import { segmentLabel, toShares } from "@/lib/trends/breakdown";

describe("segmentLabel", () => {
  it("maps daypart + tender keys and passes order-type labels through", () => {
    expect(segmentLabel("daypart", "lunch")).toBe("Lunch (11–14)");
    expect(segmentLabel("tender", "CREDIT_CARD")).toBe("Card");
    expect(segmentLabel("order_type", "Dine In")).toBe("Dine In");
  });

  it("falls back to the raw key for an unknown segment", () => {
    expect(segmentLabel("daypart", "weird")).toBe("weird");
    expect(segmentLabel("tender", "BITCOIN")).toBe("BITCOIN");
  });
});

describe("toShares", () => {
  it("computes each segment's share of the dimension total", () => {
    const out = toShares("tender", [
      { key: "CASH", value_cents: 2500, count: 5 },
      { key: "CREDIT_CARD", value_cents: 7500, count: 10 },
    ]);
    expect(out[0]).toMatchObject({ label: "Cash", value_cents: 2500, share: 0.25 });
    expect(out[1]).toMatchObject({ label: "Card", share: 0.75 });
  });

  it("returns 0 shares when the period has no value (no divide-by-zero)", () => {
    const out = toShares("order_type", [{ key: "Dine In", value_cents: 0, count: 0 }]);
    expect(out[0]?.share).toBe(0);
  });
});
