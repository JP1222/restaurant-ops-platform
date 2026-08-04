import { describe, expect, it } from "vitest";
import {
  AppSettingReadSchema,
  AppSettingUpsertSchema,
  SettingCategorySchema,
  SettingTierSchema,
  getCategory,
  getTier,
  isSettingKey,
  looksLikeSecret,
  settingCategories,
  settingKeys,
  settingTiers,
  settingsRegistry,
  validateSettingValue,
} from "./settings.js";

describe("settings registry V2", () => {
  it("exposes the `secret` category alongside existing categories", () => {
    expect(settingCategories).toContain("ai");
    expect(settingCategories).toContain("clover");
    expect(settingCategories).toContain("secret");
  });

  it("rejects unknown category values via the schema", () => {
    expect(SettingCategorySchema.safeParse("ai").success).toBe(true);
    expect(SettingCategorySchema.safeParse("secret").success).toBe(true);
    expect(SettingCategorySchema.safeParse("ssh-keys").success).toBe(false);
  });

  it("requires every registered key to declare a known category", () => {
    for (const [key, entry] of Object.entries(settingsRegistry)) {
      const parsed = SettingCategorySchema.safeParse(entry.category);
      expect(parsed.success, `key=${key} has invalid category=${entry.category}`).toBe(true);
    }
  });

  it("resolves existing registered settings without regression", () => {
    expect(validateSettingValue("ai.model_id", "deepseek-v4-pro").ok).toBe(true);
    expect(validateSettingValue("ai.thinking_mode", true).ok).toBe(true);
    expect(validateSettingValue("ai.kill_switch", false).ok).toBe(true);
  });

  it("registers ai.vision_fallback_enabled as a boolean ai setting defaulting on", () => {
    const entry = settingsRegistry["ai.vision_fallback_enabled"];
    expect(entry.category).toBe("ai");
    expect(entry.defaultValue).toBe(true);
    expect(validateSettingValue("ai.vision_fallback_enabled", true).ok).toBe(true);
    expect(validateSettingValue("ai.vision_fallback_enabled", false).ok).toBe(true);
    // Boolean key — a stray string must not slip through.
    expect(validateSettingValue("ai.vision_fallback_enabled", "yes").ok).toBe(false);
  });

  it("registers ai.web_search_enabled as a fail-closed boolean ai setting defaulting OFF", () => {
    const entry = settingsRegistry["ai.web_search_enabled"];
    // category MUST be 'ai' (NOT 'secret') so the toggle round-trips in plaintext.
    expect(entry.category).toBe("ai");
    expect(entry.tier).toBe("brand");
    // Fail-closed: web access is off until an operator intentionally flips it on.
    expect(entry.defaultValue).toBe(false);
    expect(validateSettingValue("ai.web_search_enabled", true).ok).toBe(true);
    expect(validateSettingValue("ai.web_search_enabled", false).ok).toBe(true);
    expect(validateSettingValue("ai.web_search_enabled", "on").ok).toBe(false);
  });
});

describe("getCategory()", () => {
  it("returns the registered category for a known key", () => {
    expect(getCategory("ai.model_id")).toBe("ai");
    expect(getCategory("ai.kill_switch")).toBe("ai");
  });

  it("returns null for unknown keys so callers can fail open or closed", () => {
    expect(getCategory("not.a.real.key")).toBeNull();
    expect(getCategory("")).toBeNull();
  });
});

describe("setting tiers (ADR-0018, multi-location)", () => {
  it("exposes brand and location tiers", () => {
    expect(settingTiers).toContain("brand");
    expect(settingTiers).toContain("location");
  });

  it("rejects unknown tier values via the schema", () => {
    expect(SettingTierSchema.safeParse("brand").success).toBe(true);
    expect(SettingTierSchema.safeParse("location").success).toBe(true);
    expect(SettingTierSchema.safeParse("region").success).toBe(false);
  });

  it("requires every registered key to declare a known tier", () => {
    for (const [key, entry] of Object.entries(settingsRegistry)) {
      const parsed = SettingTierSchema.safeParse(entry.tier);
      expect(parsed.success, `key=${key} has invalid tier=${entry.tier}`).toBe(true);
    }
  });

  it("returns the registered tier for a known key, null otherwise", () => {
    expect(getTier("ai.model_id")).toBe("brand");
    expect(getTier("ai.deepseek_api_key")).toBe("brand");
    expect(getTier("not.a.real.key")).toBeNull();
  });
});

describe("looksLikeSecret() (issue #205)", () => {
  // Each pattern from the acceptance criteria gets a positive case.
  const secrets: Array<[string, string]> = [
    ["sk- prefixed key", "sk-live-abc123DEF456ghi789JKL"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["Slack bot token", "xoxb-" + "2493847500-asdfQWERzxcv0987"],
    ["GitHub PAT", "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"],
    [
      "JWT",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    [
      "PEM private key",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----",
    ],
    ["RSA PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"],
    ["long hex string", "a".repeat(40)],
    ["32-char hex string", "0123456789abcdef0123456789abcdef"],
  ];

  for (const [label, value] of secrets) {
    it(`flags ${label}`, () => {
      expect(looksLikeSecret(value)).toBe(true);
    });
  }

  it("does not flag ordinary operator prose", () => {
    expect(looksLikeSecret("Always answer in a friendly, concise tone.")).toBe(false);
    expect(looksLikeSecret("Mention the daily specials when asked about the menu.")).toBe(false);
    expect(looksLikeSecret("")).toBe(false);
    // Short hex (< 32) and an order id should not trip the long-hex rule.
    expect(looksLikeSecret("deadbeef")).toBe(false);
    expect(looksLikeSecret("Order #4821 needs a refund")).toBe(false);
  });

  it("catches a secret embedded inside otherwise-benign text", () => {
    expect(looksLikeSecret("here is the key sk-live-abc123DEF456ghi789JKL use it")).toBe(true);
  });
});

describe("validateSettingValue() secret rejection (issue #205)", () => {
  it("rejects a credential pasted into a free-form string key", () => {
    const result = validateSettingValue("ai.system_prompt_append", "sk-live-abc123DEF456ghi789JKL");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("looks_like_secret");
  });

  it("rejects a JWT pasted into a free-form string key", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = validateSettingValue("ai.system_prompt_append", jwt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("looks_like_secret");
  });

  it("still accepts ordinary prose for a free-form string key", () => {
    const result = validateSettingValue("ai.system_prompt_append", "Be concise and friendly.");
    expect(result.ok).toBe(true);
  });

  it("does NOT reject credential-shaped values for category=secret keys", () => {
    // `ai.deepseek_api_key` is the encrypted secret store — it is *supposed* to
    // hold a token shaped like this.
    const result = validateSettingValue("ai.deepseek_api_key", "sk-live-abc123DEF456ghi789JKL");
    expect(result.ok).toBe(true);
  });

  it("does not run the secret check on non-string values", () => {
    expect(validateSettingValue("ai.rate_limit_per_minute", 25).ok).toBe(true);
    expect(validateSettingValue("ai.kill_switch", true).ok).toBe(true);
  });
});

describe("AppSetting concurrency schema (issue #177)", () => {
  it("AppSettingReadSchema requires a non-negative integer version", () => {
    const base = {
      key: "ai.model_id",
      category: "ai" as const,
      value: "deepseek-v4-pro",
      source: "db" as const,
      description: "",
      updatedAt: null,
      updatedBy: null,
    };
    expect(AppSettingReadSchema.safeParse({ ...base, version: 0 }).success).toBe(true);
    expect(AppSettingReadSchema.safeParse({ ...base, version: 7 }).success).toBe(true);
    expect(AppSettingReadSchema.safeParse({ ...base, version: -1 }).success).toBe(false);
    expect(AppSettingReadSchema.safeParse({ ...base, version: 1.5 }).success).toBe(false);
    // version is required now.
    expect(AppSettingReadSchema.safeParse(base).success).toBe(false);
  });

  it("AppSettingUpsertSchema accepts an optional ifVersion", () => {
    expect(AppSettingUpsertSchema.safeParse({ key: "ai.model_id", value: "x" }).success).toBe(true);
    expect(
      AppSettingUpsertSchema.safeParse({ key: "ai.model_id", value: "x", ifVersion: 3 }).success,
    ).toBe(true);
    expect(
      AppSettingUpsertSchema.safeParse({ key: "ai.model_id", value: "x", ifVersion: -2 }).success,
    ).toBe(false);
  });
});

describe("validateSettingValue() — every registered key", () => {
  it("validates each key's own declared default against its own schema", () => {
    for (const key of settingKeys) {
      const entry = settingsRegistry[key];
      const result = validateSettingValue(key, entry.defaultValue);
      expect(result.ok, `key=${key} default failed validation`).toBe(true);
    }
  });

  it("round-trips each key's default through its schema unchanged", () => {
    for (const key of settingKeys) {
      const entry = settingsRegistry[key];
      const parsed = entry.schema.parse(entry.defaultValue);
      expect(parsed, `key=${key} default did not round-trip`).toEqual(entry.defaultValue);
    }
  });

  it("rejects a known key when the value violates its schema", () => {
    // ai.model_id is free-form now (DeepSeek / Gemini / OpenAI-compatible ids all
    // fit), so it rejects on shape, not enum membership: a space + "!" are illegal.
    expect(validateSettingValue("ai.model_id", "not a model!").ok).toBe(false);
    // ai.chat_provider is the enum — an unknown provider is rejected.
    expect(validateSettingValue("ai.chat_provider", "not-a-provider").ok).toBe(false);
    expect(validateSettingValue("ai.kill_switch", "yes").ok).toBe(false);
    expect(validateSettingValue("ai.max_output_tokens", 50).ok).toBe(false); // below min 100
  });

  it("returns an error for the unknown-key path", () => {
    const result = validateSettingValue("not.a.real.key", "anything");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.error).toContain("unknown setting key");
    expect(isSettingKey("not.a.real.key")).toBe(false);
  });

  it("recognises every registered key via isSettingKey", () => {
    for (const key of settingKeys) {
      expect(isSettingKey(key)).toBe(true);
    }
  });
});
