import { describe, expect, it } from "vitest";
import {
  StoreLocationSchema,
  StoreLocationListResponseSchema,
  StoreLocationCreateSchema,
  StoreLocationBindSchema,
  UnlinkedMerchantSchema,
  StoreHoursSchema,
  StoreDayHoursSchema,
  DEFAULT_STORE_HOURS,
  deriveTodayOpen,
  formatTime12h,
} from "./location.js";

describe("StoreLocationSchema (ADR-0018)", () => {
  it("accepts a well-formed location", () => {
    const parsed = StoreLocationSchema.safeParse({
      id: "loc_ABC",
      name: "Anytown",
      slug: "store-abc",
      timezone: "America/Chicago",
      active: true,
      merchantId: "MERCH1",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a store with no POS binding (merchantId null)", () => {
    const parsed = StoreLocationSchema.safeParse({
      id: "loc_ABC",
      name: "Downtown",
      slug: "downtown",
      timezone: "America/New_York",
      active: true,
      merchantId: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a location missing required fields", () => {
    expect(StoreLocationSchema.safeParse({ id: "loc_ABC" }).success).toBe(false);
  });

  it("requires merchantId to be present (string or null, not omitted)", () => {
    expect(
      StoreLocationSchema.safeParse({
        id: "loc_ABC",
        name: "Anytown",
        slug: "store-abc",
        timezone: "America/Chicago",
        active: true,
      }).success,
    ).toBe(false);
  });

  it("wraps a list in the list-response envelope", () => {
    const parsed = StoreLocationListResponseSchema.safeParse({ locations: [] });
    expect(parsed.success).toBe(true);
  });
});

describe("POS binding (ADR-0018 onboarding step 2)", () => {
  it("StoreLocationBindSchema accepts a merchant id", () => {
    expect(StoreLocationBindSchema.safeParse({ merchantId: "ABC123" }).success).toBe(true);
  });

  it("StoreLocationBindSchema rejects an empty merchant id", () => {
    expect(StoreLocationBindSchema.safeParse({ merchantId: "" }).success).toBe(false);
  });

  it("UnlinkedMerchantSchema accepts a row with a null name", () => {
    expect(
      UnlinkedMerchantSchema.safeParse({
        id: "ABC123",
        name: null,
        authStatus: "ACTIVE",
        connectedAt: "2026-06-16T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("StoreLocationCreateSchema", () => {
  it("accepts a name + timezone", () => {
    expect(
      StoreLocationCreateSchema.safeParse({ name: "Downtown", timezone: "America/Chicago" })
        .success,
    ).toBe(true);
  });

  it("rejects a blank or whitespace-only name", () => {
    expect(
      StoreLocationCreateSchema.safeParse({ name: "   ", timezone: "America/Chicago" }).success,
    ).toBe(false);
  });

  it("requires a timezone", () => {
    expect(StoreLocationCreateSchema.safeParse({ name: "Downtown", timezone: "" }).success).toBe(
      false,
    );
  });
});

describe("StoreHoursSchema", () => {
  it("accepts the default seed (Mon–Sat 10–20, Sun 12–18)", () => {
    expect(StoreHoursSchema.safeParse(DEFAULT_STORE_HOURS).success).toBe(true);
  });

  it("accepts a closed day (null)", () => {
    expect(StoreDayHoursSchema.safeParse(null).success).toBe(true);
  });

  it("rejects open >= close", () => {
    expect(StoreDayHoursSchema.safeParse({ open: "20:00", close: "10:00" }).success).toBe(false);
    expect(StoreDayHoursSchema.safeParse({ open: "10:00", close: "10:00" }).success).toBe(false);
  });

  it("rejects a malformed time", () => {
    expect(StoreDayHoursSchema.safeParse({ open: "9:00", close: "20:00" }).success).toBe(false);
    expect(StoreDayHoursSchema.safeParse({ open: "24:00", close: "25:00" }).success).toBe(false);
  });
});

describe("formatTime12h", () => {
  it("formats 24h to 12h with AM/PM", () => {
    expect(formatTime12h("10:00")).toBe("10:00 AM");
    expect(formatTime12h("12:00")).toBe("12:00 PM");
    expect(formatTime12h("00:00")).toBe("12:00 AM");
    expect(formatTime12h("18:30")).toBe("6:30 PM");
  });
});

describe("deriveTodayOpen", () => {
  it("returns the open time for the given weekday (Sun=0)", () => {
    expect(deriveTodayOpen(DEFAULT_STORE_HOURS, 0)).toEqual({
      hour: 12,
      minute: 0,
      time: "12:00",
      label: "12:00 PM",
    });
    expect(deriveTodayOpen(DEFAULT_STORE_HOURS, 1)).toEqual({
      hour: 10,
      minute: 0,
      time: "10:00",
      label: "10:00 AM",
    });
  });

  it("captures a non-zero open minute", () => {
    const hours = { ...DEFAULT_STORE_HOURS, mon: { open: "10:30", close: "20:00" } };
    expect(deriveTodayOpen(hours, 1)).toEqual({
      hour: 10,
      minute: 30,
      time: "10:30",
      label: "10:30 AM",
    });
  });

  it("returns null when the store is closed that day", () => {
    const hours = { ...DEFAULT_STORE_HOURS, mon: null };
    expect(deriveTodayOpen(hours, 1)).toBeNull();
  });
});
