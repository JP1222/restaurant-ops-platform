import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { settingKeys } from "@rop/contracts";
import type { AppSettingRead } from "@rop/contracts";

const getSessionUserMock = vi.fn();
const listResolvedSettingsMock = vi.fn();
const upsertSettingMock = vi.fn();
const invalidateSettingMock = vi.fn();

vi.mock("@/lib/settings/session", () => ({
  getSettingsSessionUser: (...args: unknown[]) => getSessionUserMock(...args),
}));

vi.mock("@/lib/settings", () => ({
  listResolvedSettings: (...args: unknown[]) => listResolvedSettingsMock(...args),
  invalidateSetting: (...args: unknown[]) => invalidateSettingMock(...args),
}));

// Mirror the real conflict error (issue #177) so the route's
// `instanceof SettingVersionConflictError` branch resolves under the mock.
class SettingVersionConflictError extends Error {
  readonly currentVersion: number;
  readonly currentValue: string | null;
  constructor(currentVersion: number, currentValue: string | null) {
    super("setting_version_conflict");
    this.name = "SettingVersionConflictError";
    this.currentVersion = currentVersion;
    this.currentValue = currentValue;
  }
}

vi.mock("@/lib/settings/db", () => ({
  upsertSetting: (...args: unknown[]) => upsertSettingMock(...args),
  SettingVersionConflictError,
}));

vi.mock("@/lib/ai/log", () => ({
  logErrorEvent: () => {},
  errorMessage: (cause: unknown, fallback: string) =>
    cause instanceof Error ? cause.message : fallback,
}));

// The route grew a first-request boot guard (issue #244) and a secret-cache
// invalidator (issue #265) after this suite was written. Neither is the unit
// under test here, and the boot guard throws without APP_SETTING_ENCRYPTION_KEY
// in the test env — stub both so the route reaches its auth/validation logic.
vi.mock("@/lib/settings/crypto", () => ({
  assertEncryptionKeysAtBoot: () => {},
}));

vi.mock("@/lib/ai/deepseek-provider", () => ({
  invalidateApiKeyCache: () => {},
}));

const ADMIN_USER = {
  id: "acct-1",
  username: "owner",
  displayName: "Owner",
  role: "ADMIN",
};

const SAMPLE_RESOLVED: AppSettingRead[] = settingKeys.map((key) => ({
  key,
  category: "ai",
  value: null,
  source: "default",
  description: "",
  updatedAt: null,
  updatedBy: null,
  version: 0,
}));

beforeEach(() => {
  getSessionUserMock.mockReset();
  listResolvedSettingsMock.mockReset();
  upsertSettingMock.mockReset();
  invalidateSettingMock.mockReset();

  getSessionUserMock.mockResolvedValue(ADMIN_USER);
  listResolvedSettingsMock.mockResolvedValue(SAMPLE_RESOLVED);
  upsertSettingMock.mockResolvedValue({ key: "ai.model_id" });

  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet() {
  const { GET } = await import("@/app/api/settings/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost:3001/api/settings"));
}

async function callPut(body: unknown) {
  const { PUT } = await import("@/app/api/settings/route");
  const { NextRequest } = await import("next/server");
  return PUT(
    new NextRequest("http://localhost:3001/api/settings", {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("GET /api/settings", () => {
  test("returns 401 when no session", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const response = await callGet();
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("unauthorized");
  });

  test("returns 403 when session role is not ADMIN", async () => {
    getSessionUserMock.mockResolvedValueOnce({ ...ADMIN_USER, role: "VIEWER" });
    const response = await callGet();
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("forbidden");
  });

  test("returns 200 with every registered settings key for an ADMIN session", async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { settings: AppSettingRead[] };
    expect(payload.settings.map((s) => s.key).sort()).toEqual([...settingKeys].sort());
  });

  // Issue #217: short private TTL on the 200, no-store on errors.
  test("200 carries Cache-Control: private, max-age=30", async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
  });

  test("401/403 carry Cache-Control: no-store", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const unauth = await callGet();
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("cache-control")).toBe("no-store");

    getSessionUserMock.mockResolvedValueOnce({ ...ADMIN_USER, role: "VIEWER" });
    const forbidden = await callGet();
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("cache-control")).toBe("no-store");
  });
});

describe("PUT /api/settings", () => {
  test("returns 401 when no session", async () => {
    getSessionUserMock.mockResolvedValueOnce(null);
    const response = await callPut({ key: "ai.model_id", value: "deepseek-v4-pro" });
    expect(response.status).toBe(401);
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  test("returns 403 when session role is not ADMIN", async () => {
    getSessionUserMock.mockResolvedValueOnce({ ...ADMIN_USER, role: "VIEWER" });
    const response = await callPut({ key: "ai.model_id", value: "deepseek-v4-pro" });
    expect(response.status).toBe(403);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("forbidden");
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  test("returns 400 invalid_json for a malformed body", async () => {
    const response = await callPut("{ not json");
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_json");
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  test("returns 400 unknown_key for a key not in the registry", async () => {
    const response = await callPut({ key: "ai.not_a_real_key", value: 1 });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; key: string };
    expect(payload.error).toBe("unknown_key");
    expect(payload.key).toBe("ai.not_a_real_key");
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  test("returns 400 invalid_value when the value fails the key schema", async () => {
    // ai.chat_provider is an enum — an unknown provider fails validation. (ai.model_id
    // is free-form now, so it would no longer reject an arbitrary model id here.)
    const response = await callPut({ key: "ai.chat_provider", value: "not-a-provider" });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("invalid_value");
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  // Issue #167: scrub error details before returning to the browser. The
  // rejected user-supplied value must never round-trip through the 400 body.
  test("invalid_body 400 returns sanitized issues, not the raw value", async () => {
    // Type mismatch on a known field -> AppSettingUpsertSchema rejects shape.
    const SECRET = "sk-live-OPERATOR-PASTED-SECRET-0123456789";
    const response = await callPut({ key: 123, value: SECRET });
    expect(response.status).toBe(400);

    const raw = await response.text();
    expect(raw).not.toContain(SECRET);

    const payload = JSON.parse(raw) as {
      error: string;
      issues?: Array<{ path: string; code: string }>;
      message?: unknown;
    };
    expect(payload.error).toBe("invalid_body");
    expect(Array.isArray(payload.issues)).toBe(true);
    // Sanitized shape only: { path, code } — no `message`, no `received`.
    for (const issue of payload.issues ?? []) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
    expect(payload.message).toBeUndefined();
  });

  test("invalid_value 400 does not echo the rejected user-supplied value", async () => {
    // A 2KB+ string fails `ai.system_prompt_append`'s `.max(2000)` — zod's raw
    // message embeds the rejected value server-side; the response must not.
    const HUGE = "X".repeat(2100);
    const response = await callPut({ key: "ai.system_prompt_append", value: HUGE });
    expect(response.status).toBe(400);

    const raw = await response.text();
    expect(raw).not.toContain(HUGE);
    expect(raw).not.toContain("XXXXXXXXXX");

    const payload = JSON.parse(raw) as { error: string; code?: string; details?: unknown };
    expect(payload.error).toBe("invalid_value");
    expect(payload.code).toBe("value_failed_validation");
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  test("returns 200 and upserts the stringified value for a valid payload", async () => {
    const response = await callPut({ key: "ai.rate_limit_per_minute", value: 25 });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);

    expect(upsertSettingMock).toHaveBeenCalledTimes(1);
    const args = upsertSettingMock.mock.calls[0]?.[0] as {
      key: string;
      value: string;
      category: string;
      updatedBy: string | null;
      updatedByUsername?: string | null;
    };
    expect(args.key).toBe("ai.rate_limit_per_minute");
    expect(args.value).toBe(JSON.stringify(25));
    expect(args.category).toBe("ai");
    expect(args.updatedBy).toBe(ADMIN_USER.id);
    // Audit denormalization (issue #159): the route hands the username through.
    expect(args.updatedByUsername).toBe(ADMIN_USER.username);
  });

  // Issue #205: a credential pasted into a free-form string key is rejected at
  // the contract layer, surfaced as 400 invalid_value, and never upserted.
  test("rejects a secret-shaped value for a free-form string key (400, no upsert)", async () => {
    const SECRET = "sk-live-abc123DEF456ghi789JKL";
    const response = await callPut({ key: "ai.system_prompt_append", value: SECRET });
    expect(response.status).toBe(400);
    const raw = await response.text();
    // The rejected secret must never round-trip through the body.
    expect(raw).not.toContain(SECRET);
    const payload = JSON.parse(raw) as { error: string };
    expect(payload.error).toBe("invalid_value");
    expect(upsertSettingMock).not.toHaveBeenCalled();
  });

  // Issue #177: the route forwards a client-supplied ifVersion to the writer.
  test("forwards ifVersion to upsertSetting when present", async () => {
    const response = await callPut({
      key: "ai.rate_limit_per_minute",
      value: 25,
      ifVersion: 3,
    });
    expect(response.status).toBe(200);
    const args = upsertSettingMock.mock.calls[0]?.[0] as { ifVersion?: number };
    expect(args.ifVersion).toBe(3);
  });

  test("omits ifVersion from the upsert call when the client doesn't send one", async () => {
    await callPut({ key: "ai.rate_limit_per_minute", value: 25 });
    const args = upsertSettingMock.mock.calls[0]?.[0] as { ifVersion?: number };
    expect(args.ifVersion).toBeUndefined();
  });

  // Issue #177: a version mismatch maps to 409 conflict with the current value
  // so the UI can offer "reload, then re-apply".
  test("maps a version conflict to 409 with currentVersion + currentValue", async () => {
    upsertSettingMock.mockRejectedValueOnce(
      new SettingVersionConflictError(5, JSON.stringify(50)),
    );
    const response = await callPut({
      key: "ai.rate_limit_per_minute",
      value: 25,
      ifVersion: 4,
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as {
      error: string;
      code: string;
      currentVersion: number;
      currentValue: unknown;
    };
    expect(payload.error).toBe("conflict");
    expect(payload.code).toBe("version_conflict");
    expect(payload.currentVersion).toBe(5);
    // The JSON-encoded stored value is parsed back to its native shape.
    expect(payload.currentValue).toBe(50);
  });

  // Issue #177 + #247: a conflict on a secret key must NOT echo the value.
  test("a version conflict on a secret key omits currentValue from the 409 body", async () => {
    upsertSettingMock.mockRejectedValueOnce(
      new SettingVersionConflictError(2, JSON.stringify("sk-should-never-leak")),
    );
    const response = await callPut({
      key: "ai.deepseek_api_key",
      value: "sk-new-rotation-value",
      ifVersion: 1,
    });
    expect(response.status).toBe(409);
    const raw = await response.text();
    expect(raw).not.toContain("sk-should-never-leak");
    const payload = JSON.parse(raw) as { error: string; currentVersion: number; currentValue?: unknown };
    expect(payload.error).toBe("conflict");
    expect(payload.currentVersion).toBe(2);
    expect("currentValue" in payload).toBe(false);
  });
});
