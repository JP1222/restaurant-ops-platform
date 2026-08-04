import {
  AppSettingUpsertSchema,
  getCategory,
  settingsRegistry,
  validateSettingValue,
  isSettingKey,
} from "@rop/contracts";
import type { ZodError } from "zod";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { invalidateApiKeyCache } from "@/lib/ai/deepseek-provider";
import { assertEncryptionKeysAtBoot } from "@/lib/settings/crypto";
import { SettingVersionConflictError, upsertSetting } from "@/lib/settings/db";
import { invalidateSetting, listResolvedSettings } from "@/lib/settings";
import { getSettingsSessionUser } from "@/lib/settings/session";
import { can, webAdminRoleToRole } from "@rop/auth/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Private + short TTL on the settings list (issue #217). The hook already uses
// `staleTime: 60_000`; this lets a hard reload or a second tab serve from the
// browser cache instead of re-fetching the full list every mount. `private`
// keeps it out of any shared proxy cache (the response is per-admin and may
// carry secret-presence flags). Errors are `no-store`.
const LIST_CACHE_CONTROL = "private, max-age=30";
const NO_STORE = "no-store";

function jsonNoStore(body: unknown, status: number): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE },
  });
}

/**
 * Reduce a ZodError to a leak-free `[{ path, code }]` shape (issue #167).
 * Drops `message` and the rejected `received`/`input` value so a 2KB operator
 * string can never round-trip through the 400 body.
 */
function sanitizeZodIssues(error: ZodError): Array<{ path: string; code: string }> {
  return error.issues.map((issue) => ({
    // Map each segment through String() first: zod path elements are
    // PropertyKey (string | number | symbol) and a bare .join would throw on a
    // symbol segment. Stringifying keeps the path render-safe.
    path: issue.path.map((segment) => String(segment)).join("."),
    code: issue.code,
  }));
}

// Fail-fast at first request (issue #244): a missing/malformed
// APP_SETTING_ENCRYPTION_KEY should take the route down before any read or
// write happens. We do NOT validate at module-load because `next build`'s
// "Collecting page data" phase imports route modules WITHOUT secrets in env,
// which would break CI. First-request validation surfaces the same error
// before the route can ever return a corrupt result.
let bootChecked = false;
function ensureBootValidated(): void {
  if (bootChecked) return;
  assertEncryptionKeysAtBoot();
  bootChecked = true;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    ensureBootValidated();
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.settings.boot",
      message: errorMessage(error, "boot_failed"),
    });
    return jsonNoStore({ error: "internal_error" }, 500);
  }

  const user = await getSettingsSessionUser(request);
  if (!user) {
    return jsonNoStore({ error: "unauthorized" }, 401);
  }
  // Settings are owner-scoped. db-auth accounts default to OWNER (the legacy
  // "ADMIN" string the old check looked for is no longer issued — that mismatch
  // locked the owner out). Gate on the suite permission via rbac instead.
  if (!can(webAdminRoleToRole(user.role), "settings.read")) {
    return jsonNoStore({ error: "forbidden" }, 403);
  }

  try {
    const settings = await listResolvedSettings();
    // Strip plaintext for secret rows on the list endpoint. Operators reveal
    // via the per-key GET (which audits). `valuePresent` lets the UI know
    // whether the row has a stored value without leaking the value itself.
    const sanitized = settings.map((row) => {
      if (getCategory(row.key) !== "secret") return row;
      const value = typeof row.value === "string" ? row.value : "";
      const hasValue = value !== "";
      // Surface ONLY the last 4 chars so the UI can render a "••••4f2a"
      // connection veneer (BYOK) without ever shipping the full credential —
      // the plaintext is nulled out here; operators still reveal the whole value
      // via the audited per-key GET. A short key (<8) yields no tail to avoid
      // leaking a meaningful fraction of it.
      const maskedTail = hasValue && value.length >= 8 ? value.slice(-4) : null;
      return { ...row, value: null, valuePresent: hasValue, maskedTail };
    });
    return NextResponse.json(
      { settings: sanitized },
      { headers: { "Cache-Control": LIST_CACHE_CONTROL } },
    );
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.settings.list",
      message: errorMessage(error, "list_failed"),
    });
    return jsonNoStore({ error: "internal_error" }, 500);
  }
}

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    ensureBootValidated();
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.settings.boot",
      message: errorMessage(error, "boot_failed"),
    });
    return jsonNoStore({ error: "internal_error" }, 500);
  }

  const user = await getSettingsSessionUser(request);
  if (!user) {
    return jsonNoStore({ error: "unauthorized" }, 401);
  }
  if (!can(webAdminRoleToRole(user.role), "settings.write")) {
    return jsonNoStore({ error: "forbidden" }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonNoStore({ error: "invalid_json" }, 400);
  }

  const parsed = AppSettingUpsertSchema.safeParse(body);
  if (!parsed.success) {
    // Scrub before returning (issue #167): the raw zod message echoes the
    // rejected value and full path back to the browser (a 2KB
    // `ai.system_prompt_append` would round-trip). Emit only `{ path, code }`;
    // keep the verbose error server-side for debugging.
    logErrorEvent({
      scope: "backoffice.api.settings.invalid_body",
      message: parsed.error.message,
    });
    return jsonNoStore(
      { error: "invalid_body", issues: sanitizeZodIssues(parsed.error) },
      400,
    );
  }

  const { key, value, ifVersion } = parsed.data;
  if (!isSettingKey(key)) {
    return jsonNoStore({ error: "unknown_key", key }, 400);
  }

  const validation = validateSettingValue(key, value);
  if (!validation.ok) {
    // `validation.error` carries the contract layer's full zod message, which
    // includes the rejected value — never return it verbatim, and don't echo a
    // prefix of it either (zod messages routinely lead with the rejected
    // input) (issue #167). Log it server-side; hand the browser a stable code.
    logErrorEvent({
      scope: "backoffice.api.settings.invalid_value",
      message: validation.error,
      context: { key },
    });
    return jsonNoStore(
      { error: "invalid_value", code: "value_failed_validation", key },
      400,
    );
  }

  try {
    const entry = settingsRegistry[key];
    await upsertSetting({
      key,
      value: JSON.stringify(validation.value),
      category: entry.category,
      updatedBy: user.id,
      updatedByUsername: user.username,
      // Optimistic last-write-wins (issue #177): only pass it through when the
      // client sent one, so callers that don't track versions keep working.
      ...(ifVersion !== undefined ? { ifVersion } : {}),
    });
    // Bust the in-process resolved-setting TTL cache (issue #195) so the write
    // takes effect on the very next read rather than after the cache window —
    // critical for the kill switch and rate-limit keys the chat route reads
    // hot. `invalidateSetting` is the generic cache hole punched for every key.
    invalidateSetting(key);
    // The DeepSeek client keeps its own decoded-API-key cache on top of the
    // settings layer; punch that hole too on a key rotation (issue #195). Add
    // new consumer-specific invalidators here as other caches grow.
    if (key === "ai.deepseek_api_key") {
      invalidateApiKeyCache();
    }
    // Always return `{ ok: true }` only — for secret keys we MUST NOT echo the
    // saved value back. See #247 acceptance criteria.
    return jsonNoStore({ ok: true }, 200);
  } catch (error) {
    // Optimistic-concurrency conflict (issue #177): another admin saved this
    // key since the client read it. Return 409 with the current version so the
    // UI can offer "reload, then re-apply". The current value rides along for
    // non-secret keys; for secret keys we never echo plaintext (see #247) so we
    // strip it and the UI just prompts a reload.
    if (error instanceof SettingVersionConflictError) {
      logErrorEvent({
        scope: "backoffice.api.settings.conflict",
        message: "version_conflict",
        context: { key, userId: user.id, currentVersion: error.currentVersion },
      });
      const includeValue = getCategory(key) !== "secret";
      // `error.currentValue` is the JSON-encoded stored string; parse it so the
      // 409 body carries the same parsed shape the list endpoint returns,
      // letting the UI drop it straight back into the field.
      let currentValue: unknown = null;
      if (includeValue && error.currentValue !== null) {
        try {
          currentValue = JSON.parse(error.currentValue);
        } catch {
          currentValue = null;
        }
      }
      return jsonNoStore(
        {
          error: "conflict",
          code: "version_conflict",
          key,
          currentVersion: error.currentVersion,
          ...(includeValue ? { currentValue } : {}),
        },
        409,
      );
    }
    logErrorEvent({
      scope: "backoffice.api.settings.upsert",
      message: errorMessage(error, "upsert_failed"),
      context: { key, userId: user.id },
    });
    return jsonNoStore({ error: "internal_error" }, 500);
  }
}
