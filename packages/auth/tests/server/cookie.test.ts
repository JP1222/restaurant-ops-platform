import { describe, expect, it } from "vitest";
import { WEBAUTHN_FLOW_TTL_SECONDS, WEBAUTHN_TIMEOUT_MS } from "../../src/server/cookie.js";

describe("WEBAUTHN_TIMEOUT_MS", () => {
  it("is expressed in milliseconds", () => {
    expect(WEBAUTHN_TIMEOUT_MS).toBe(4 * 60 * 1000);
  });

  it("stays one minute under the Redis flow TTL (GH #148)", () => {
    // The ceremony must time out before the challenge is evicted from Redis so
    // the authenticator never emits an assertion for a discarded challenge.
    expect(WEBAUTHN_TIMEOUT_MS).toBe((WEBAUTHN_FLOW_TTL_SECONDS - 60) * 1000);
    expect(WEBAUTHN_TIMEOUT_MS).toBeLessThan(WEBAUTHN_FLOW_TTL_SECONDS * 1000);
  });
});
