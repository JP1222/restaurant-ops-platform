-- Drop the legacy PLAINTEXT POS OAuth token columns now that every secret is
-- read cipher-only (AES-256-GCM under AI_TOKEN_ENCRYPTION_KEY in the *Cipher
-- columns added by 20260617_pos_token_cipher + 20260618_pos_token_refresh_recovery_cipher).
--
-- This is the CHECKPOINT the two prior cipher migrations deferred. It removes
-- the dual-read window's plaintext columns so nightly R2 backups + replication
-- no longer capture readable POS tokens (P1-6 of the 2026-06-18 secret-management
-- audit, docs/audits/2026-06-18-secret-management-audit.md).
--
-- PRECONDITION (met): the prod backfill
-- (apps/kds-api/src/scripts/backfill-pos-token-cipher.ts) ran on 2026-06-18 and
-- reported `remaining plaintext: 0` — every existing secret is encrypted in its
-- *Cipher column and the plaintext columns below are empty. #761 (the
-- refresh/recovery cipher columns + backfill) was merged 2026-06-17 and DEPLOYED
-- 2026-06-18 ~20:00 (build-images run 27785693557); the backfill ran after that
-- deploy. The cipher-only app code (resolvers in apps/kds-api/src/lib/pos-token.ts
-- and its callers) ships in the SAME image as this migration, and the Prisma
-- migrate sidecar runs `migrate deploy` before the app starts, so there is no
-- intermediate state where the running app reads a column that no longer exists.
--
-- ROLLBACK: re-add the columns as NULLABLE
--   ALTER TABLE "pos_accounts"     ADD COLUMN "accessToken"   TEXT;
--   ALTER TABLE "pos_accounts"     ADD COLUMN "refreshToken"  TEXT;
--   ALTER TABLE "clover_merchants" ADD COLUMN "accessToken"   TEXT;
--   ALTER TABLE "clover_merchants" ADD COLUMN "refreshToken"  TEXT;
--   ALTER TABLE "clover_merchants" ADD COLUMN "recoveryToken" TEXT;
-- The data they held was already mirrored into the *Cipher columns (and blanked
-- on every encrypting write), so no live-path secret is lost by this drop — a
-- rolled-back app simply dual-reads empty plaintext + the populated cipher.
-- NOTE: the originals were `accessToken` NOT NULL; re-add as NULLABLE because
-- the encrypting write path no longer supplies a plaintext value.

-- DropColumn
ALTER TABLE "pos_accounts" DROP COLUMN "accessToken";
ALTER TABLE "pos_accounts" DROP COLUMN "refreshToken";

ALTER TABLE "clover_merchants" DROP COLUMN "accessToken";
ALTER TABLE "clover_merchants" DROP COLUMN "refreshToken";
ALTER TABLE "clover_merchants" DROP COLUMN "recoveryToken";
