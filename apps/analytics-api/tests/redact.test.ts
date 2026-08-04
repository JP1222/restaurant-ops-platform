import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/lib/redact.js";

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    const out = redactSecrets("auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(out).toBe("auth failed: [REDACTED]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts Authorization-style Bearer tokens mid-string", () => {
    const out = redactSecrets("headers: Authorization=Bearer abc123def456ghi789jkl012mno345pqr");
    expect(out).not.toContain("abc123def456ghi789jkl012mno345pqr");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts postgres:// connection strings", () => {
    const out = redactSecrets("connect ECONNREFUSED postgres://user:s3cret@db.internal:5432/analytics");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("db.internal");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts postgresql:// connection strings", () => {
    const out = redactSecrets("postgresql://app:hunter2@10.0.0.1/db failed");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts redis:// and rediss:// connection strings", () => {
    expect(redactSecrets("redis://:p4ss@cache:6379/0")).not.toContain("p4ss");
    expect(redactSecrets("rediss://:tlsp4ss@cache:6380/1")).not.toContain("tlsp4ss");
  });

  it("redacts long base64-ish credential blobs (32+ chars)", () => {
    const blob = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    const out = redactSecrets(`token leak: ${blob}`);
    expect(out).not.toContain(blob);
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary error prose untouched", () => {
    const msg = "Clover export 12345 failed with status FAILED.";
    expect(redactSecrets(msg)).toBe(msg);
  });

  it("does not over-redact short hex-ish ids", () => {
    const msg = "order abc123 not found";
    expect(redactSecrets(msg)).toBe(msg);
  });
});
