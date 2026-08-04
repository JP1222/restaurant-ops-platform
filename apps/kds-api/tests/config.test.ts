import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";

// Minimum required env to keep tests focused on the empty-string handling.
// Keys are camelCase to match what loadConfig() passes into ConfigSchema —
// loadConfig handles the UPPER_SNAKE → camelCase mapping from process.env.
const REQUIRED = {
  databaseUrl: "postgres://localhost/test",
  redisUrl: "redis://localhost",
};

describe("ConfigSchema empty-string normalization", () => {
  // Regression test for the same incident class as backoffice-web's
  // PR #72 — docker-compose's `${VAR:-}` expansion passes "" for unset
  // host envs; zod `.optional()` rejects "" but accepts undefined.
  // Without preprocess, kds-api would refuse to boot whenever the operator
  // left WEB_LOGIN_USERNAME / WEB_LOGIN_PASSWORD_HASH unset in the stack env.
  it("treats empty-string optional fields as unset", () => {
    const parsed = ConfigSchema.safeParse({
      ...REQUIRED,
      webLoginUsername: "",
      webLoginPasswordHash: "",
      webauthnRpId: "",
      kdsInternalAdminToken: "",
      deliverectWebhookSecret: "",
      cloverMerchantId: "",
      cloverToken: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.webLoginUsername).toBeUndefined();
      expect(parsed.data.webLoginPasswordHash).toBeUndefined();
      expect(parsed.data.webauthnRpId).toBeUndefined();
      expect(parsed.data.kdsInternalAdminToken).toBeUndefined();
      // Fields without `.min(N)` (cloverMerchantId etc.) also become undefined
      // — keeps the downstream "is Clover configured?" check honest, instead
      // of "configured but blank".
      expect(parsed.data.deliverectWebhookSecret).toBeUndefined();
      expect(parsed.data.cloverMerchantId).toBeUndefined();
      expect(parsed.data.cloverToken).toBeUndefined();
    }
  });

  it("passes non-empty optional values through unchanged", () => {
    const parsed = ConfigSchema.safeParse({
      ...REQUIRED,
      webLoginUsername: "admin",
      webLoginPasswordHash: "$argon2id$...",
      kdsInternalAdminToken: "0123456789abcdef0123",
      cloverMerchantId: "MERCHANT123",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.webLoginUsername).toBe("admin");
      expect(parsed.data.webLoginPasswordHash).toBe("$argon2id$...");
      expect(parsed.data.kdsInternalAdminToken).toBe(
        "0123456789abcdef0123",
      );
      expect(parsed.data.cloverMerchantId).toBe("MERCHANT123");
    }
  });

  it("defaults cloverSyncMaxAgeMinutes to 90 and coerces a string override (GH #154)", () => {
    const def = ConfigSchema.safeParse({ ...REQUIRED, cloverSyncMaxAgeMinutes: "" });
    expect(def.success).toBe(true);
    if (def.success) {
      expect(def.data.cloverSyncMaxAgeMinutes).toBe(90);
    }
    const override = ConfigSchema.safeParse({ ...REQUIRED, cloverSyncMaxAgeMinutes: "30" });
    expect(override.success).toBe(true);
    if (override.success) {
      expect(override.data.cloverSyncMaxAgeMinutes).toBe(30);
    }
  });

  it("still fails when a required field is empty (now as Required, not Too small)", () => {
    const parsed = ConfigSchema.safeParse({
      databaseUrl: "",
      redisUrl: "redis://localhost",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("databaseUrl");
    }
  });

  it("default-having fields recover when given an empty string", () => {
    // sessionSecret has .default("replace-me") + .min(8). Empty string would
    // bypass the default in vanilla zod (because "" is "provided"); with the
    // preprocess, "" → undefined → default kicks in.
    const parsed = ConfigSchema.safeParse({
      ...REQUIRED,
      sessionSecret: "",
      webLoginDisplayName: "",
      webauthnRpName: "",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sessionSecret).toBe("replace-me");
      expect(parsed.data.webLoginDisplayName).toBe("Kitchen Admin");
      expect(parsed.data.webauthnRpName).toBe("Example Kitchen KDS");
    }
  });
});
