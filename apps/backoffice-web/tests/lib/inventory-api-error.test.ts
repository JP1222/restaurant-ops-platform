import { describe, expect, test } from "vitest";

import { InventoryApiError, isVisionTimeout } from "@/hooks/use-inventory";

describe("InventoryApiError", () => {
  test("extracts the BFF error code from a JSON body and keeps the legacy message shape", () => {
    const err = new InventoryApiError(
      "/api/inventory/receipt-parse",
      504,
      '{"error":"vision_timeout"}'
    );
    expect(err.status).toBe(504);
    expect(err.code).toBe("vision_timeout");
    expect(err.message).toBe('/api/inventory/receipt-parse 504: {"error":"vision_timeout"}');
    expect(err).toBeInstanceOf(Error);
  });

  test("leaves code undefined for a non-JSON body", () => {
    const err = new InventoryApiError("/api/inventory", 502, "<html>Bad Gateway</html>");
    expect(err.code).toBeUndefined();
    expect(err.status).toBe(502);
  });

  test("leaves code undefined when the JSON error field is not a string", () => {
    const err = new InventoryApiError("/api/inventory", 400, '{"error":{"nested":true}}');
    expect(err.code).toBeUndefined();
  });
});

describe("isVisionTimeout", () => {
  test("matches the 504 vision_timeout contract from the receipt-parse route", () => {
    const err = new InventoryApiError(
      "/api/inventory/receipt-parse",
      504,
      '{"error":"vision_timeout"}'
    );
    expect(isVisionTimeout(err)).toBe(true);
  });

  test("matches a bare infra 504 with a non-JSON body (same retry guidance)", () => {
    const err = new InventoryApiError("/api/inventory/receipt-parse", 504, "Gateway Timeout");
    expect(isVisionTimeout(err)).toBe(true);
  });

  test("does not match other parse failures or foreign errors", () => {
    expect(
      isVisionTimeout(
        new InventoryApiError("/api/inventory/receipt-parse", 502, '{"error":"parse_failed"}')
      )
    ).toBe(false);
    expect(
      isVisionTimeout(
        new InventoryApiError("/api/inventory/receipt-parse", 503, '{"error":"ai_disabled"}')
      )
    ).toBe(false);
    expect(isVisionTimeout(new Error("vision_timeout"))).toBe(false);
    expect(isVisionTimeout(undefined)).toBe(false);
  });
});
