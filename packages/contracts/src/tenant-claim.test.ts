import { describe, expect, it } from "vitest";

import type { AnalyticsTenantClaim } from "./tenant.js";
import { signAnalyticsTenantClaim, verifyAnalyticsTenantClaim } from "./tenant-claim.js";

const KEY = "test-signing-key-0123456789abcdef";
const NOW = 1_700_000_000;

function makeClaim(overrides: Partial<AnalyticsTenantClaim> = {}): AnalyticsTenantClaim {
  return {
    tenantId: "tenant-default",
    merchantIds: ["MERCH_A", "MERCH_B"],
    iat: NOW,
    exp: NOW + 300,
    ...overrides
  };
}

describe("analytics tenant claim sign/verify", () => {
  it("round-trips a valid claim", () => {
    const token = signAnalyticsTenantClaim(makeClaim(), KEY);
    expect(verifyAnalyticsTenantClaim(token, KEY, NOW)).toEqual(makeClaim());
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const token = signAnalyticsTenantClaim(makeClaim({ merchantIds: ["MERCH_A"] }), KEY);
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify(makeClaim({ merchantIds: ["VICTIM_MERCH"] })),
      "utf8"
    ).toString("base64url");
    expect(verifyAnalyticsTenantClaim(`${forgedPayload}.${sig}`, KEY, NOW)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signAnalyticsTenantClaim(makeClaim(), KEY);
    const [payload] = token.split(".");
    expect(verifyAnalyticsTenantClaim(`${payload}.deadbeef`, KEY, NOW)).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = signAnalyticsTenantClaim(makeClaim(), "other-key");
    expect(verifyAnalyticsTenantClaim(token, KEY, NOW)).toBeNull();
  });

  it("rejects an expired claim (exp <= now)", () => {
    expect(verifyAnalyticsTenantClaim(signAnalyticsTenantClaim(makeClaim({ exp: NOW }), KEY), KEY, NOW)).toBeNull();
    expect(
      verifyAnalyticsTenantClaim(signAnalyticsTenantClaim(makeClaim({ exp: NOW + 1 }), KEY), KEY, NOW)
    ).not.toBeNull();
  });

  it("rejects malformed tokens and an empty key", () => {
    expect(verifyAnalyticsTenantClaim("not-a-token", KEY, NOW)).toBeNull();
    expect(verifyAnalyticsTenantClaim(".", KEY, NOW)).toBeNull();
    expect(verifyAnalyticsTenantClaim("", KEY, NOW)).toBeNull();
    expect(verifyAnalyticsTenantClaim(signAnalyticsTenantClaim(makeClaim(), KEY), "", NOW)).toBeNull();
  });
});
