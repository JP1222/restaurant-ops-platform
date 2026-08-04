import { describe, expect, test } from "vitest";
import { redactSecrets } from "@/lib/redact";
import { logRouteError } from "@/lib/auth/http";
import { handleInventoryApiError } from "@/lib/inventory-api/route-error";
import { InventoryApiError } from "@/lib/inventory-api/client";
import { logErrorEvent } from "@/lib/ai/log";

describe("redactSecrets", () => {
  test("redacts Bearer tokens", () => {
    const out = redactSecrets("upstream 502: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts postgres:// connection strings", () => {
    const out = redactSecrets("ECONNREFUSED postgres://user:s3cret@db.internal:5432/analytics");
    expect(out).not.toContain("s3cret");
    expect(out).not.toContain("db.internal");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts postgresql:// connection strings", () => {
    expect(redactSecrets("postgresql://app:hunter2@10.0.0.1/db")).not.toContain("hunter2");
  });

  test("redacts redis:// and rediss:// connection strings", () => {
    expect(redactSecrets("redis://:p4ss@cache:6379/0")).not.toContain("p4ss");
    expect(redactSecrets("rediss://:tlsp4ss@cache:6380/1")).not.toContain("tlsp4ss");
  });

  test("redacts long base64-ish credential blobs (32+ chars)", () => {
    const blob = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    const out = redactSecrets(`leaked: ${blob}`);
    expect(out).not.toContain(blob);
    expect(out).toContain("[REDACTED]");
  });

  test("leaves ordinary error prose untouched", () => {
    const msg = "passkey verification failed for user admin";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe("logRouteError", () => {
  test("redacts secrets in the serialized log line", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => {
      lines.push(line);
    };
    try {
      logRouteError(
        "backoffice.auth.passkey.verify",
        new Error("upstream 500 from analytics-api: Bearer sk_live_" + "abcdef0123456789abcdef0123456789")
      );
    } finally {
      console.error = original;
    }

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("error");
    expect(parsed.scope).toBe("backoffice.auth.passkey.verify");
    expect(parsed.message).not.toContain("sk_live_" + "abcdef0123456789abcdef0123456789");
    expect(parsed.message).toContain("[REDACTED]");
  });

  test("falls back to a generic message for non-Error throwables", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => {
      lines.push(line);
    };
    try {
      logRouteError("backoffice.auth.session", "raw string failure");
    } finally {
      console.error = original;
    }
    expect(JSON.parse(lines[0]!).message).toBe("Unknown backoffice auth error");
  });
});

describe("handleInventoryApiError", () => {
  test("redacts secrets in the upstream body it logs (but still returns 502)", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => {
      lines.push(line);
    };
    let status: number;
    try {
      const response = handleInventoryApiError(
        new InventoryApiError(
          502,
          "upstream 502: ECONNREFUSED postgres://inv:s3cret@db.internal:5432/inventory",
          "http://inventory-api/api/items"
        ),
        "backoffice.api.inventory.items"
      );
      status = response.status;
    } finally {
      console.error = original;
    }

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.scope).toBe("backoffice.api.inventory.items");
    expect(parsed.upstreamStatus).toBe(502);
    expect(parsed.message).not.toContain("s3cret");
    expect(parsed.message).not.toContain("db.internal");
    expect(parsed.message).toContain("[REDACTED]");
    expect(status).toBe(502);
  });
});

describe("logErrorEvent", () => {
  test("redacts secrets in the serialized message", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: string) => {
      lines.push(line);
    };
    try {
      logErrorEvent({
        scope: "backoffice.api.ai.oauth.complete",
        message: "token exchange failed: Bearer sk_live_" + "abcdef0123456789abcdef0123456789"
      });
    } finally {
      console.error = original;
    }

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.scope).toBe("backoffice.api.ai.oauth.complete");
    expect(parsed.message).not.toContain("sk_live_" + "abcdef0123456789abcdef0123456789");
    expect(parsed.message).toContain("[REDACTED]");
  });
});
