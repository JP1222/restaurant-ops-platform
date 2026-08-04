import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { validatePasswordStrength } from "../../src/server/password-policy.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubHibpRange(body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200 })),
  );
}

function hibpSuffix(password: string) {
  return createHash("sha1").update(password).digest("hex").toUpperCase().slice(5);
}

describe("validatePasswordStrength", () => {
  it("rejects passwords shorter than the 15-char minimum", async () => {
    stubHibpRange("");
    const result = await validatePasswordStrength("too-short");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too_short");
    }
  });

  it("rejects a known-breached password (suffix present in the HIBP range)", async () => {
    const password = "correct-horse-battery-staple";
    stubHibpRange(`${hibpSuffix(password)}:128\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1`);
    const result = await validatePasswordStrength(password);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("breached");
    }
  });

  it("accepts a long, non-breached password", async () => {
    stubHibpRange("0000000000000000000000000000000000A:1");
    const result = await validatePasswordStrength("a-long-unique-passphrase-2026!");
    expect(result.ok).toBe(true);
  });

  it("fails open (accepts) when the breach service is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const result = await validatePasswordStrength("another-long-unique-passphrase");
    expect(result.ok).toBe(true);
  });
});
