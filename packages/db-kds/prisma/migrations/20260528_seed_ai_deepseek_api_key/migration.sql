-- Phase B of the AppSetting-as-secret-store pivot (issue #263): seed the row
-- the DeepSeek client will read. The value is intentionally plain '""' (an
-- empty JSON-encoded string) rather than a pre-encrypted envelope because:
--   1. AES-GCM uses a random nonce per call, so we cannot hard-code a
--      "canonical" empty envelope at migration-authoring time.
--   2. Migrations have no access to APP_SETTING_ENCRYPTION_KEY (and shouldn't —
--      they're versioned, the key is not).
--   3. The first PUT /api/settings for this key, made by an operator pasting
--      a real key into /settings/system, routes through `upsertSetting()`
--      which calls `encryptSecret(...)` because the registry sets
--      category=secret. From that point forward the row is properly encrypted.
--
-- Until an operator writes a real value, `decryptIfSecret()` in
-- lib/settings/db.ts will fail to parse the empty value as an envelope and
-- log a `decrypt_failed` event per read. The resolver then treats the row as
-- missing and falls through to the env fallback (DEEPSEEK_API_KEY), then to
-- the registry default (empty string). The DeepSeek client surfaces a
-- typed error if both are empty.
--
-- ON CONFLICT DO NOTHING keeps the migration idempotent across reruns and
-- preserves any previously-written ciphertext.
INSERT INTO "app_setting" ("merchantId", "key", "value", "category", "createdAt", "updatedAt")
VALUES ('default-merchant', 'ai.deepseek_api_key', '""', 'secret', NOW(), NOW())
ON CONFLICT ("merchantId", "key") DO NOTHING;
