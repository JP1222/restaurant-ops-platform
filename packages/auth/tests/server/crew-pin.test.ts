import { describe, expect, it } from "vitest";

import {
  hashPin,
  pinLookupHash,
  signCrewSession,
  verifyCrewSession,
  verifyPin,
  type CrewSessionPayload
} from "../../src/server/crew-pin.js";

const SECRET = "test-crew-session-secret";
const PEPPER = "test-crew-pin-pepper";

function futurePayload(overrides: Partial<CrewSessionPayload> = {}): CrewSessionPayload {
  return {
    employeeId: "EMP-1",
    name: "Maya Reyes",
    exp: Date.now() + 60_000,
    ...overrides
  };
}

describe("crew PIN hashing", () => {
  it("hashes and verifies a PIN", async () => {
    const hashed = await hashPin("1234");

    expect(hashed).toContain("$argon2");
    await expect(verifyPin("1234", hashed)).resolves.toBe(true);
  });

  it("rejects a wrong PIN", async () => {
    const hashed = await hashPin("1234");

    await expect(verifyPin("9999", hashed)).resolves.toBe(false);
  });
});

describe("pinLookupHash", () => {
  it("is deterministic for the same pin + pepper", () => {
    expect(pinLookupHash("1234", PEPPER)).toBe(pinLookupHash("1234", PEPPER));
  });

  it("differs by pin and by pepper", () => {
    expect(pinLookupHash("1234", PEPPER)).not.toBe(pinLookupHash("5678", PEPPER));
    expect(pinLookupHash("1234", PEPPER)).not.toBe(pinLookupHash("1234", "other-pepper"));
  });
});

describe("crew session token", () => {
  it("round-trips a valid payload", () => {
    const payload = futurePayload();
    const token = signCrewSession(payload, SECRET);

    expect(verifyCrewSession(token, SECRET)).toEqual(payload);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signCrewSession(futurePayload(), SECRET);

    expect(verifyCrewSession(token, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signCrewSession(futurePayload(), SECRET);
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify(futurePayload({ name: "Attacker" }))
    ).toString("base64url");

    expect(verifyCrewSession(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signCrewSession(futurePayload({ exp: Date.now() - 1 }), SECRET);

    expect(verifyCrewSession(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyCrewSession("not-a-token", SECRET)).toBeNull();
  });
});
