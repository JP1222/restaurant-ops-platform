import { describe, expect, it } from "vitest";
import { sanitizeCloverPayload } from "../src/lib/sanitize.js";

describe("sanitize Clover payloads", () => {
  it("removes nested payment and account sensitive fields", () => {
    const sanitized = sanitizeCloverPayload({
      id: "payment1",
      card: {
        last4: "4242",
        bin: "411111",
        expirationDate: "12/30",
        cardholderName: "Private Customer",
        safe: "kept"
      },
      tracks: [{ track1: "secret" }, { track2: "secret" }],
      accountNumber: "123",
      routingNumber: "456"
    });

    expect(sanitized).toEqual({
      id: "payment1",
      card: {
        safe: "kept"
      },
      tracks: [{}, {}]
    });
  });
});
