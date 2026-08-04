import { describe, expect, test } from "vitest";
import { ServerEnvSchema } from "@/lib/env";

// Minimal "happy path" env that satisfies the two required fields. Tests
// extend this with field-specific overrides instead of restating it.
const REQUIRED = {
  ANALYTICS_ADMIN_TOKEN: "tok",
  INTERNAL_ANALYTICS_API_URL: "http://analytics-api:4001",
};

describe("ServerEnvSchema empty-string normalization", () => {
  // Regression test for prod incident 2026-05-21: docker-compose passes
  // `${VAR:-}` as an empty string when the host env is unset; zod's
  // `.optional()` only accepts undefined, so every API route that imported
  // `getServerEnv()` died with "Too small" on GITHUB_PIPELINE_TOKEN.
  test("empty-string optional fields become undefined (not min(N) violation)", () => {
    const result = ServerEnvSchema.safeParse({
      ...REQUIRED,
      GITHUB_PIPELINE_TOKEN: "",
      KDS_INTERNAL_ADMIN_TOKEN: "",
      INTERNAL_KDS_API_URL: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GITHUB_PIPELINE_TOKEN).toBeUndefined();
      expect(result.data.KDS_INTERNAL_ADMIN_TOKEN).toBeUndefined();
      expect(result.data.INTERNAL_KDS_API_URL).toBeUndefined();
    }
  });

  test("non-empty optional values pass through unchanged", () => {
    const result = ServerEnvSchema.safeParse({
      ...REQUIRED,
      GITHUB_PIPELINE_TOKEN: "ghp_xxx",
      KDS_INTERNAL_ADMIN_TOKEN: "0123456789abcdef0123",
      INTERNAL_KDS_API_URL: "http://kds-api:4000",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GITHUB_PIPELINE_TOKEN).toBe("ghp_xxx");
      expect(result.data.KDS_INTERNAL_ADMIN_TOKEN).toBe(
        "0123456789abcdef0123",
      );
      expect(result.data.INTERNAL_KDS_API_URL).toBe("http://kds-api:4000");
    }
  });

  test("empty-string required field still fails (now as Required, not Too small)", () => {
    const result = ServerEnvSchema.safeParse({
      ...REQUIRED,
      ANALYTICS_ADMIN_TOKEN: "", // overrides REQUIRED — required, empty now == unset
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Empty-string-as-undefined means the failure mode is "required missing"
      // rather than "string too small". Either is acceptable behavior; we
      // assert the field is the one in error.
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("ANALYTICS_ADMIN_TOKEN");
    }
  });

  test("defaults still apply when key is absent", () => {
    const result = ServerEnvSchema.safeParse(REQUIRED);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GITHUB_REPO_OWNER).toBe("example-org");
      expect(result.data.GITHUB_REPO_NAME).toBe("restaurant-ops-platform");
      expect(result.data.BACKOFFICE_SESSION_COOKIE_NAME).toBe(
        "rop_backoffice_session",
      );
    }
  });

  test("empty-string default-having field also gets the default", () => {
    // GITHUB_REPO_OWNER has `.default("example-org")`. If we passed an empty
    // string and DIDN'T normalize, zod would accept "" (it satisfies `.min(1)`
    // — wait, no, .min(1) would reject it). So normalize → undefined → default
    // kicks in. This is the desired chain.
    const result = ServerEnvSchema.safeParse({
      ...REQUIRED,
      GITHUB_REPO_OWNER: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.GITHUB_REPO_OWNER).toBe("example-org");
    }
  });
});
