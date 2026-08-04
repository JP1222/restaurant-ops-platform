-- Phase 4.5 Step 4.5.1: encrypt Deliverect credentials at rest.
--
-- Adds nullable cipher columns to kds_provider_configs. The existing plaintext
-- `apiToken` and `hmacSecret` columns are retained during the rollout window
-- so the application can fall back to them when cipher columns are still null
-- (e.g. rows written by the legacy Floor editor). A follow-up migration
-- (Phase 4.5.7, queued for a future PR) drops the plaintext columns once the
-- backfill script has migrated existing rows.

ALTER TABLE "kds_provider_configs"
    ADD COLUMN "apiTokenCipher" BYTEA,
    ADD COLUMN "hmacSecretCipher" BYTEA;
