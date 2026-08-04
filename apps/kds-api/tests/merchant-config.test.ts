import { describe, expect, it } from "vitest";
import {
  pickExternalPaymentTenderId,
  pickTaxableOrderTypeId,
} from "../src/domain/merchant-config.js";

describe("pickTaxableOrderTypeId", () => {
  it("prefers the default taxable order type", () => {
    expect(
      pickTaxableOrderTypeId({
        elements: [
          { id: "O1", taxable: false, isDefault: true },
          { id: "O2", taxable: true, isDefault: false },
          { id: "O3", taxable: true, isDefault: true },
        ],
      }),
    ).toBe("O3");
  });

  it("falls back to the first taxable when none is default", () => {
    expect(
      pickTaxableOrderTypeId({
        elements: [
          { id: "O1", taxable: false },
          { id: "O2", taxable: true },
        ],
      }),
    ).toBe("O2");
  });

  it("returns null when no taxable order type exists (bare merchant)", () => {
    expect(pickTaxableOrderTypeId({ elements: [] })).toBeNull();
    expect(pickTaxableOrderTypeId({ elements: [{ id: "O1", taxable: false }] })).toBeNull();
  });
});

describe("pickExternalPaymentTenderId", () => {
  it("finds the External Payment tender by labelKey (not the gift-card one)", () => {
    expect(
      pickExternalPaymentTenderId({
        elements: [
          { id: "T1", labelKey: "com.clover.tender.cash" },
          { id: "T2", labelKey: "com.clover.tender.external_gift_card" },
          { id: "T3", labelKey: "com.clover.tender.external_payment" },
        ],
      }),
    ).toBe("T3");
  });

  it("returns null when there is no External Payment tender", () => {
    expect(
      pickExternalPaymentTenderId({ elements: [{ id: "T1", labelKey: "com.clover.tender.cash" }] }),
    ).toBeNull();
  });
});
