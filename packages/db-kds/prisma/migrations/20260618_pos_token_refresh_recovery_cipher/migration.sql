-- Extend POS at-rest encryption to the refresh + recovery OAuth secrets.
--
-- The prior migration `20260617_pos_token_cipher` added accessTokenCipher to
-- pos_accounts + clover_merchants (PR #750). This follow-up completes the set so
-- EVERY POS OAuth secret is encrypted uniformly (AES-256-GCM under
-- AI_TOKEN_ENCRYPTION_KEY, mirroring KdsProviderConfig.apiTokenCipher):
--   * pos_accounts     — refreshTokenCipher
--   * clover_merchants — refreshTokenCipher, recoveryTokenCipher
-- (accessTokenCipher on both already exists from 20260617.)
--
-- WHY THIS MIGRATION DOES NOT ENCRYPT EXISTING ROWS: encryption needs the
-- AI_TOKEN_ENCRYPTION_KEY master key, which a raw-SQL migration sidecar has no
-- access to. Purely ADDITIVE — creates nullable cipher columns and leaves the
-- plaintext columns populated. The app-layer backfill
-- (apps/kds-api/src/scripts/backfill-pos-token-cipher.ts), run once after deploy
-- with the key in env, encrypts existing plaintext rows and blanks the plaintext.
-- New writes encrypt on the spot (clover-client / square-account + the
-- resolve*/encryptSecretForStorage helpers).
--
-- COMPATIBILITY / ROLLBACK: additive only. Reads dual-read (cipher preferred,
-- plaintext fallback) so a not-yet-backfilled row keeps working byte-for-byte.
-- Rolling back is dropping the three new columns; no live-path data is lost
-- (the plaintext columns remain authoritative until the backfill runs).
--
-- CHECKPOINT: a LATER, separately-checkpointed migration drops the plaintext
-- accessToken/refreshToken/recoveryToken columns — but only AFTER the prod
-- backfill is verified to leave zero plaintext rows (Deliverect Phase 4.5.7
-- pattern). Do not fold that drop into this migration.

-- AlterTable
ALTER TABLE "pos_accounts" ADD COLUMN "refreshTokenCipher" BYTEA;

-- AlterTable
ALTER TABLE "clover_merchants" ADD COLUMN "refreshTokenCipher" BYTEA;
ALTER TABLE "clover_merchants" ADD COLUMN "recoveryTokenCipher" BYTEA;
