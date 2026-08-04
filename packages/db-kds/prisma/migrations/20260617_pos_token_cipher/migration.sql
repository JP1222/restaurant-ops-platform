-- Encrypt POS provider access tokens at rest (mirror of the Deliverect Phase
-- 4.5 pattern on kds_provider_configs). Adds a nullable AES-256-GCM cipher
-- column alongside the existing plaintext accessToken on BOTH the new
-- pos_accounts credential table and the legacy clover_merchants per-store row,
-- so every POS credential is encrypted uniformly going forward.
--
-- COMPATIBILITY / DUAL-READ: purely ADDITIVE. The plaintext `accessToken`
-- columns are LEFT IN PLACE and stay populated on existing rows; the
-- application reads the cipher when present and falls back to the plaintext
-- column otherwise (apps/kds-api: resolveStoredAccessToken). New writes set the
-- cipher and blank the plaintext to ''. A SQL migration CANNOT backfill ciphers
-- — encryption needs the app-layer AI_TOKEN_ENCRYPTION_KEY — so existing rows
-- stay plaintext-readable until an app-layer re-write (next token refresh /
-- bootstrap / connect) or a backfill script re-encrypts them (a later,
-- separately-checkpointed migration then drops the plaintext columns; cf.
-- Deliverect Phase 4.5.7).
--
-- ROLLBACK: drop the two new columns. No data on the existing plaintext path is
-- lost (it was never moved, only mirrored into the cipher on write).

ALTER TABLE "pos_accounts" ADD COLUMN "accessTokenCipher" BYTEA;
ALTER TABLE "clover_merchants" ADD COLUMN "accessTokenCipher" BYTEA;
