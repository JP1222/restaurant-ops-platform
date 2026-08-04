import {
  settingsRegistry,
  isSettingKey,
  type AppSettingRead,
  type SettingKey,
  type SettingSource,
  type SettingValue,
} from "@rop/contracts";
import { findAllSettings, findSetting } from "./db";

/**
 * Resolution order for any setting value:
 *
 *   1. DB `app_setting` row — UI-editable, takes effect on next read.
 *   2. env var (if the descriptor declares one) — for cold-start defaults
 *      and env-provided values.
 *   3. Hardcoded default from `settingsRegistry`.
 *
 * Every layer is run through the key's zod schema. A malformed DB row or
 * env value silently falls through to the next layer; the `source` field
 * on the returned record makes the actual layer visible to the UI.
 */

function parseRawJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readEnv(key: SettingKey): unknown {
  const envVar = settingsRegistry[key].envVar;
  if (!envVar) return undefined;
  const raw = process.env[envVar];
  if (raw === undefined) return undefined;
  // env values are plain strings; for boolean/number keys we coerce here.
  // We try JSON parse first (so "true" / "false" / "42" / '"foo"' all work),
  // then fall back to the raw string.
  const parsed = parseRawJson(raw);
  return parsed ?? raw;
}

interface ResolveResult<K extends SettingKey> {
  value: SettingValue<K>;
  source: SettingSource;
}

function resolveValue<K extends SettingKey>(
  key: K,
  dbValue: string | undefined,
): ResolveResult<K> {
  const entry = settingsRegistry[key];
  if (dbValue !== undefined) {
    const parsed = parseRawJson(dbValue);
    const validated = entry.schema.safeParse(parsed);
    if (validated.success) {
      return { value: validated.data as SettingValue<K>, source: "db" };
    }
  }
  const envValue = readEnv(key);
  if (envValue !== undefined) {
    const validated = entry.schema.safeParse(envValue);
    if (validated.success) {
      return { value: validated.data as SettingValue<K>, source: "env" };
    }
  }
  return { value: entry.defaultValue as SettingValue<K>, source: "default" };
}

/**
 * Per-process TTL cache for resolved setting values (issue #195).
 *
 * The AI chat route reads `ai.kill_switch`, `ai.rate_limit_per_minute`,
 * `ai.model_id`, `ai.thinking_mode`, `ai.max_output_tokens`, and
 * `ai.system_prompt_append` on EVERY request — each was a separate Prisma
 * `findUnique`. ADR-0016 §"Consequences" anticipated this: "if it becomes hot,
 * add a per-process TTL cache." A 5s window keeps the kill switch's
 * MTTR well under a human's hand-off while collapsing the steady-state read to
 * an in-memory Map lookup (sub-ms, no DB round-trip).
 *
 * Correctness condition: every write busts the affected key
 * (`invalidateSetting`), so a save takes effect on the next read, not after the
 * TTL. The cache keys on the setting key only — `getSetting` resolves the
 * brand scope (no per-location read today); a future location-scoped reader
 * must extend the key before sharing this cache.
 */
const SETTING_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const settingCache = new Map<SettingKey, CacheEntry>();

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const now = Date.now();
  const cached = settingCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as SettingValue<K>;
  }
  const row = await findSetting(key);
  const value = resolveValue(key, row?.value).value;
  settingCache.set(key, { value, expiresAt: now + SETTING_CACHE_TTL_MS });
  return value;
}

/**
 * Drop the cached value for `key` so the next `getSetting` re-reads from the
 * DB. Called from the PUT `/api/settings` route after a successful upsert
 * (issue #195). Idempotent — a miss is a no-op.
 */
export function invalidateSetting(key: SettingKey): void {
  settingCache.delete(key);
}

/** Test seam: clear the whole cache between cases. Not used in app code. */
export function __clearSettingCache(): void {
  settingCache.clear();
}

export async function listResolvedSettings(): Promise<AppSettingRead[]> {
  const rows = await findAllSettings();
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return (Object.keys(settingsRegistry) as SettingKey[]).map((key) => {
    const entry = settingsRegistry[key];
    const row = byKey.get(key);
    const { value, source } = resolveValue(key, row?.value);
    return {
      key,
      category: entry.category,
      value,
      source,
      description: entry.description,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
      // Optimistic-concurrency token (issue #177): 0 when there's no DB row yet
      // (env/default source). The UI echoes this back as `ifVersion` on save.
      version: row?.version ?? 0,
    };
  });
}

export { isSettingKey };
