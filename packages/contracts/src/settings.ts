import { z } from "zod";

// `secret` (added in schema V2 / issue #245) is the marker for keys whose
// values are credentials. The UI masks them by category; sibling issues
// #244 (encryption at rest) and #247 (masked input) consume this value via
// the `getCategory()` helper below without depending on the full registry
// shape.
export const settingCategories = ["ai", "clover", "secret", "backup"] as const;
export const SettingCategorySchema = z.enum(settingCategories);
export type SettingCategory = z.infer<typeof SettingCategorySchema>;

// `tier` (ADR-0018, multi-location) marks whether a key is shared across the
// whole brand or set per store. Brand-tier keys resolve under a single brand
// scope; location-tier keys resolve under the active location's id. The scope
// resolver lives in `apps/backoffice-web/lib/settings`.
export const settingTiers = ["brand", "location"] as const;
export const SettingTierSchema = z.enum(settingTiers);
export type SettingTier = z.infer<typeof SettingTierSchema>;

// DeepSeek chat-model aliases — kept as the suggestion list for the chat-model
// dropdown when ai.chat_provider = deepseek, and as the default for ai.model_id /
// ai.match_model_id. No longer the *schema* for ai.model_id (that is free-form
// now so Gemini / OpenAI-compatible ids fit too — see AiChatModelIdSchema).
export const aiModelIds = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;
export const AiModelIdSchema = z.enum(aiModelIds);

// The AI chat brain can run on more than DeepSeek (the original lock):
//   - `gemini`            reuses the existing Gemini key (ai.vision_api_key).
//   - `openai`            first-class OpenAI, billed against ai.openai_api_key.
//   - `anthropic`         first-class Claude, billed against ai.anthropic_api_key.
//   - `openai-compatible` any OpenAI-style endpoint via ai.chat_base_url + ai.chat_api_key.
// `openai`/`anthropic` connect via a stored API key (BYOK), billed against your own
// account. The generic `openai-compatible` stays for self-hosted / proxy endpoints.
export const aiChatProviders = ["deepseek", "gemini", "openai", "anthropic", "openai-compatible"] as const;
export const AiChatProviderSchema = z.enum(aiChatProviders);
export type AiChatProvider = z.infer<typeof AiChatProviderSchema>;

// Chat / matcher model ids are free-form provider strings: DeepSeek aliases
// (deepseek-v4-pro), Google (gemini-2.5-flash), or any OpenAI-compatible id —
// which may carry a namespace or tag (meta-llama/Llama-3.1-8B, qwen2.5:7b). Validate
// shape only; allow letters, digits, and . _ - : / so all three providers fit.
export const AiChatModelIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9._:/-]+$/, "model id: letters, digits, and . _ - : / only");

// Optional backup TEXT model (ai.text_fallback_model_id): same character rules as the
// chat model id, but EMPTY-allowed — empty means "no fallback". Tried once on the SAME
// provider when the unattended scan-flow text calls (receipt matcher / emoji suggester)
// fail with a transient error. The chat assistant is interactive (a user just resends),
// so it is intentionally not on this retry path.
export const AiChatFallbackModelIdSchema = z
  .string()
  .max(96)
  .regex(/^[A-Za-z0-9._:/-]*$/, "model id: letters, digits, and . _ - : / only (empty = no fallback)");

// Base URL for the OpenAI-compatible chat provider. Empty unless that provider is
// selected; when set it must be an http(s) URL (the SDK appends the completions path).
export const AiChatBaseUrlSchema = z
  .string()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\/.+/.test(v), "must be an http(s) URL");

// Vision (invoice-scan) model ids are free-form provider strings — e.g. Google
// "gemini-flash-latest" — not the fixed DeepSeek chat enum, so validate shape
// only. DeepSeek's API has no image-capable model, so invoice scan (ADR-0538)
// runs on Gemini instead.
export const AiVisionModelIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "model id: letters, digits, dot, dash, underscore only");

// Optional backup vision model (ai.vision_fallback_model_id): same character rules as the
// primary, but EMPTY-allowed — an empty string means "no fallback". Tried once when the
// primary vision call fails transiently (e.g. a Gemini "high demand" overload) and the scan
// budget still has time left.
export const AiVisionFallbackModelIdSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9._-]*$/, "model id: letters, digits, dot, dash, underscore only (empty = no fallback)");

// Databases eligible for the automated backup job (scripts/backup-postgres.sh).
// Each maps 1:1 to a `postgres-*` compose service; the host script dumps the
// subset listed in `backup.databases`. Kept as an enum so an operator can't
// enable a backup for a database that doesn't exist. See OPERATIONS.md §8.
export const backupDatabaseIds = ["kds", "analytics", "inventory", "crm"] as const;
export const BackupDatabaseIdSchema = z.enum(backupDatabaseIds);

interface SettingDescriptor<S extends z.ZodTypeAny> {
  tier: SettingTier;
  category: SettingCategory;
  schema: S;
  defaultValue: z.infer<S>;
  envVar?: string;
  description: string;
}

function descriptor<S extends z.ZodTypeAny>(d: SettingDescriptor<S>): SettingDescriptor<S> {
  return d;
}

// Single source of truth: per-key zod schemas, defaults, env fallback names.
// The DB column `app_setting.value` is a JSON-encoded string; this registry
// drives both write-time validation (PUT /api/settings) and read-time parsing
// (lib/settings).
export const settingsRegistry = {
  "ai.chat_provider": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiChatProviderSchema,
    defaultValue: "deepseek",
    envVar: "AI_CHAT_PROVIDER",
    description:
      "Which AI service powers the chat assistant: DeepSeek (text), Google Gemini (text + images), OpenAI, Anthropic Claude, or any OpenAI-compatible endpoint. Each uses its own saved key.",
  }),
  "ai.model_id": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiChatModelIdSchema,
    defaultValue: "deepseek-v4-pro",
    envVar: "DEEPSEEK_MODEL_ID",
    description:
      "The chat model to use — e.g. deepseek-v4-pro, gemini-2.5-flash, or any model your endpoint serves.",
  }),
  "ai.chat_base_url": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiChatBaseUrlSchema,
    defaultValue: "",
    envVar: "AI_CHAT_BASE_URL",
    description:
      "Endpoint URL for an OpenAI-compatible provider (e.g. https://api.openai.com/v1). Used when chat or receipt matching is set to OpenAI-compatible.",
  }),
  "ai.match_provider": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiChatProviderSchema,
    defaultValue: "deepseek",
    envVar: "AI_MATCH_PROVIDER",
    description:
      "Which AI service powers invoice/receipt line matching and emoji-icon suggestions: DeepSeek, Google Gemini, OpenAI, Anthropic Claude, or any OpenAI-compatible endpoint. Independent of the chat assistant, so you can run them on different providers.",
  }),
  "ai.match_model_id": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiChatModelIdSchema,
    defaultValue: "deepseek-v4-pro",
    envVar: "AI_MATCH_MODEL_ID",
    description:
      "The model used to match scanned invoice lines to your catalog and to suggest item emoji.",
  }),
  "ai.vision_model_id": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiVisionModelIdSchema,
    defaultValue: "gemini-flash-latest",
    envVar: "AI_VISION_MODEL_ID",
    description:
      "The model that reads invoice/receipt photos. Must be a Google Gemini model (default gemini-flash-latest); uses your Gemini key.",
  }),
  "ai.vision_fallback_model_id": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiVisionFallbackModelIdSchema,
    defaultValue: "gemini-3.1-flash-lite",
    envVar: "AI_VISION_FALLBACK_MODEL_ID",
    description:
      'Backup Gemini vision model for invoice scan. Tried once if the primary (ai.vision_model_id) fails with a transient error — classically a Gemini "high demand" overload — and time remains in the scan budget. Empty = no fallback. Uses the same Gemini key.',
  }),
  "ai.vision_thinking_level": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.enum(["minimal", "low", "medium", "high"]),
    defaultValue: "low",
    envVar: "AI_VISION_THINKING_LEVEL",
    description:
      "How much hidden 'thinking' the Gemini vision model spends per invoice scan. Invoice extraction is OCR + structuring, not reasoning, and a thinking-capable flash model left uncapped burns a large, VARIABLE reasoning budget that dominates scan latency and cost (a heavy invoice was measured spending ~14k output tokens / ~77s, almost all of it invisible thinking). Lower = faster + cheaper; raise toward 'high' only if extraction accuracy drops on dense or low-quality invoices. Applies to both the primary and fallback vision models.",
  }),
  "ai.text_fallback_model_id": descriptor({
    tier: "brand",
    category: "ai",
    schema: AiChatFallbackModelIdSchema,
    defaultValue: "",
    envVar: "AI_TEXT_FALLBACK_MODEL_ID",
    description:
      "Backup TEXT model for the unattended scan-flow calls — invoice/receipt line matching and emoji-icon suggestions. Tried once on the SAME provider as the matcher (ai.match_provider) if the primary (ai.match_model_id) fails with a transient error — e.g. a provider overload. Empty = no fallback. The chat assistant is interactive (just resend), so it is not on this retry path.",
  }),
  "ai.vision_fallback_enabled": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.boolean(),
    defaultValue: true,
    envVar: "AI_VISION_FALLBACK_ENABLED",
    description:
      "When the chat brain can't see images (deepseek, or a text-only openai-compatible endpoint) and the user attaches an image/PDF, route THAT turn to the Gemini vision model (ai.vision_model_id, reusing ai.vision_api_key) so the conversation can still discuss the file. A multimodal chat provider (gemini) handles images itself and ignores this. Off = images are dropped from the chat request (original text-only behavior); the invoice Scan-receipt flow is unaffected either way.",
  }),
  "ai.thinking_mode": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.boolean(),
    defaultValue: false,
    envVar: "AI_THINKING_MODE",
    description:
      "Let the model reason step-by-step before answering — slower, but higher quality. (DeepSeek chat only.)",
  }),
  "ai.max_output_tokens": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.number().int().min(100).max(32_000),
    defaultValue: 4000,
    envVar: "AI_MAX_OUTPUT_TOKENS",
    description: "Maximum length of a single AI reply (in tokens).",
  }),
  "ai.rate_limit_per_minute": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.number().int().min(1).max(1000),
    defaultValue: 10,
    envVar: "AI_RATE_LIMIT_PER_MINUTE",
    description:
      "Maximum chat-assistant requests per minute, shared across all staff. Separate from the Floor invoice-scan limit (ai.scan_rate_limit_per_minute) so a busy chat session can't starve a cook's scan.",
  }),
  "ai.scan_rate_limit_per_minute": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.number().int().min(1).max(1000),
    defaultValue: 20,
    envVar: "AI_SCAN_RATE_LIMIT_PER_MINUTE",
    description:
      "Maximum Floor invoice-scan (receipt-parse) requests per minute, shared across all staff and devices. Its own bucket, separate from the chat assistant; the best-effort match/emoji assists the scan fires are exempt from rate limiting (they degrade silently and are bounded by this parse limit upstream).",
  }),
  "ai.kill_switch": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.boolean(),
    defaultValue: false,
    envVar: "AI_MONTHLY_SPEND_KILL_SWITCH",
    description: "Emergency off switch — instantly stops the AI assistant until turned back on.",
  }),
  "ai.web_search_enabled": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.boolean(),
    defaultValue: false,
    envVar: "AI_WEB_SEARCH_ENABLED",
    description:
      "When true, the AI chat assistant may call the read-only web_search tool (Gemini grounding with Google Search, reusing ai.vision_api_key). Default OFF (fail-closed); flip on intentionally. Disable to cut web access without a redeploy if prompt-injection is suspected.",
  }),
  "ai.match_confidence_threshold": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.number().min(0).max(1),
    defaultValue: 0.7,
    envVar: "AI_MATCH_CONFIDENCE_THRESHOLD",
    description:
      "How confident the AI must be (0–1) to auto-match a scanned invoice line to an existing item. Lower = more auto-matches; higher = leaves more for you to confirm.",
  }),
  "ai.emoji_suggest_enabled": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.boolean(),
    defaultValue: true,
    envVar: "AI_EMOJI_SUGGEST_ENABLED",
    description:
      "Automatically pick an emoji icon for an item from its name — when you create or rename one, or when a scan adds a new item. Only fills items that don't already have an icon.",
  }),
  "ai.system_prompt_append": descriptor({
    tier: "brand",
    category: "ai",
    schema: z.string().max(2000),
    defaultValue: "",
    envVar: "AI_SYSTEM_PROMPT_APPEND",
    description: "Extra instructions added to every chat assistant conversation.",
  }),
  // Operator-rotatable credentials (category=secret): encrypted at rest, set via
  // /settings/ai. Each `envVar` is a fallback for env-injected setups.
  "ai.deepseek_api_key": descriptor({
    tier: "brand",
    category: "secret",
    schema: z.string(),
    defaultValue: "",
    envVar: "DEEPSEEK_API_KEY",
    description: "API key for DeepSeek (powers chat and, by default, invoice matching).",
  }),
  "ai.vision_api_key": descriptor({
    tier: "brand",
    category: "secret",
    schema: z.string(),
    defaultValue: "",
    envVar: "GEMINI_API_KEY",
    description:
      "Google Gemini API key — reads invoice photos, and powers Gemini chat or matching if you select it.",
  }),
  "ai.chat_api_key": descriptor({
    tier: "brand",
    category: "secret",
    schema: z.string(),
    defaultValue: "",
    envVar: "AI_CHAT_API_KEY",
    description: "API key for your OpenAI-compatible endpoint.",
  }),
  "ai.openai_api_key": descriptor({
    tier: "brand",
    category: "secret",
    schema: z.string(),
    defaultValue: "",
    envVar: "OPENAI_API_KEY",
    description:
      "API key for OpenAI (sk-…) — powers chat or invoice matching when the OpenAI provider is selected. Billed against your OpenAI account; this stored key is the connection.",
  }),
  "ai.anthropic_api_key": descriptor({
    tier: "brand",
    category: "secret",
    schema: z.string(),
    defaultValue: "",
    envVar: "ANTHROPIC_API_KEY",
    description:
      "API key for Anthropic Claude (sk-ant-…) — powers chat or invoice matching when the Anthropic provider is selected. Billed against your Anthropic account; the Messages API is API-key-only, so this stored key is the connection.",
  }),
  // ── Backup ────────────────────────────────────────────────────────────────
  // Operator-tunable knobs for the nightly Postgres→R2 backup job
  // (scripts/backup-postgres.sh, run from host cron). The host script reads
  // these rows directly from postgres-kds and mirrors the DB→env→default
  // precedence in bash, so the envVar names + defaultValues here are the
  // contract it falls back to. Credentials (R2 token, age recipient) are NOT
  // here — per ADR-0016 §4 secrets stay in env; see OPERATIONS.md §8.
  "backup.enabled": descriptor({
    tier: "brand",
    category: "backup",
    schema: z.boolean(),
    defaultValue: true,
    envVar: "BACKUP_ENABLED",
    description:
      "Master switch for the nightly Postgres backup. When false, scripts/backup-postgres.sh exits without dumping (the host cron entry stays installed, so re-enabling needs no host change).",
  }),
  "backup.databases": descriptor({
    // No envVar: this is the one array-valued key, and the env fallback path in
    // lib/settings coerces scalars only. The host script honors its own
    // BACKUP_DATABASES env (comma-separated) independently; the canonical source
    // is this DB row (a JSON array) or the default below.
    tier: "brand",
    category: "backup",
    schema: z.array(BackupDatabaseIdSchema),
    defaultValue: ["kds", "analytics", "inventory", "crm"],
    description:
      "Which Postgres databases the job dumps. analytics is rebuildable from Clover, so it is the safe one to drop first if you ever trim scope; kds/inventory/crm hold irreplaceable write-source data.",
  }),
  "backup.retention_days": descriptor({
    tier: "brand",
    category: "backup",
    schema: z.number().int().min(1).max(365),
    defaultValue: 30,
    envVar: "BACKUP_RETENTION_DAYS",
    description:
      "Days of dumps to keep in R2 before the job prunes older objects. R2 DeleteObject is free and these dumps are tiny, so this is bounded by convenience, not cost (10 GB free tier ≫ the data).",
  }),
  "backup.encrypt": descriptor({
    tier: "brand",
    category: "backup",
    schema: z.boolean(),
    defaultValue: true,
    envVar: "BACKUP_ENCRYPT",
    description:
      "Client-side encrypt each dump with age before upload (recipient = BACKUP_AGE_RECIPIENT env). crm holds customer PII, so this defaults on; when true but no recipient is set the job FAILS rather than upload plaintext.",
  }),
} as const;

export type SettingKey = keyof typeof settingsRegistry;
export const settingKeys = Object.keys(settingsRegistry) as readonly SettingKey[];

export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsRegistry)[K]["schema"]>;

export type SettingSource = "db" | "env" | "default";

export const AppSettingReadSchema = z.object({
  key: z.string(),
  category: SettingCategorySchema,
  value: z.unknown(),
  source: z.enum(["db", "env", "default"]),
  description: z.string(),
  updatedAt: z.string().datetime().nullable(),
  updatedBy: z.string().nullable(),
  // Monotonic revision counter for optimistic last-write-wins (issue #177).
  // 0 means "no DB row yet" (env/default source); the row's own version starts
  // at 0 and increments on every persisted write. The UI echoes the value it
  // read back as `ifVersion` on save so the BFF can 409 a clobbering edit.
  version: z.number().int().nonnegative(),
});
export type AppSettingRead = z.infer<typeof AppSettingReadSchema>;

export const AppSettingUpsertSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  // Optimistic-concurrency guard (issue #177): the version the client last saw.
  // Omitted = unconditional write (back-compat for callers that don't track it).
  // When present and it does not match the row's current version, the PUT route
  // returns 409 `conflict` with the current value so the UI can reload + re-apply.
  ifVersion: z.number().int().nonnegative().optional(),
});
export type AppSettingUpsert = z.infer<typeof AppSettingUpsertSchema>;

export const AppSettingListResponseSchema = z.object({
  settings: z.array(AppSettingReadSchema),
});
export type AppSettingListResponse = z.infer<typeof AppSettingListResponseSchema>;

export function isSettingKey(key: string): key is SettingKey {
  return key in settingsRegistry;
}

export interface SettingValidationOk {
  ok: true;
  value: unknown;
}
export interface SettingValidationErr {
  ok: false;
  error: string;
}

// Obvious-secret shapes (issue #205). ADR-0016 §4 mandates "secrets stay in
// env"; the only key allowed to hold credential material is `category=secret`
// (encrypted at rest). Every other string setting flows back through the BFF
// list response on each GET, so a pasted token there is a real exposure once
// non-admin roles arrive. This is a best-effort heuristic — it catches the
// common provider-token and PEM shapes, not every conceivable secret.
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI / DeepSeek / Stripe-style prefixed keys: sk-..., sk-live-..., rk_...
  /\bsk-[A-Za-z0-9_-]{16,}/,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/,
  // Slack bot/user/app tokens: xoxb-, xoxp-, xoxa-, xoxs-, xoxr-.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  // GitHub personal-access / OAuth / app tokens.
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/,
  // Compact JWT (three base64url segments separated by dots).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // PEM private key block (RSA / EC / OPENSSH / generic).
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  // Long contiguous hex string (>= 32 chars): API secrets, hashes, signing keys.
  /\b[0-9a-fA-F]{32,}\b/,
];

/**
 * Heuristic gate for "this string looks like a credential" (issue #205).
 *
 * Returns true when `raw` contains a recognizable secret shape (prefixed
 * provider tokens, AWS keys, JWTs, PEM private keys, long hex strings). Used by
 * `validateSettingValue` to reject such values for non-`secret` string keys so
 * an operator can't paste `sk-...` into `ai.system_prompt_append`. Pure and
 * side-effect free; safe to call anywhere.
 */
export function looksLikeSecret(raw: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(raw));
}

export function validateSettingValue(
  key: string,
  raw: unknown,
): SettingValidationOk | SettingValidationErr {
  if (!isSettingKey(key)) {
    return { ok: false, error: `unknown setting key: ${key}` };
  }
  const entry = settingsRegistry[key];
  const result = entry.schema.safeParse(raw);
  if (!result.success) return { ok: false, error: result.error.message };
  // Reject credential-shaped strings on any key that is NOT itself a secret
  // store (issue #205). `category=secret` rows are encrypted at rest and meant
  // to hold tokens; everything else must stay credential-free because it
  // round-trips through the plaintext BFF list response.
  if (
    typeof result.data === "string" &&
    entry.category !== "secret" &&
    looksLikeSecret(result.data)
  ) {
    return { ok: false, error: "looks_like_secret" };
  }
  return { ok: true, value: result.data };
}

// Narrow accessor for sibling features that need to branch on category alone
// (encryption layer in issue #244, UI masking in issue #247) without
// depending on the full registry shape. Returns null for unknown keys so
// callers can decide whether to fail open or closed.
export function getCategory(key: string): SettingCategory | null {
  if (!isSettingKey(key)) return null;
  return settingsRegistry[key].category;
}

// Companion to getCategory for the multi-location scope resolver (ADR-0018):
// brand-tier keys are shared org-wide, location-tier keys are per store.
export function getTier(key: string): SettingTier | null {
  if (!isSettingKey(key)) return null;
  return settingsRegistry[key].tier;
}
