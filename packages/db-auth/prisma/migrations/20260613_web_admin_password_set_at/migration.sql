-- ADR-0029: add a nullable `passwordSetAt` marker to web_admin_accounts.
--
-- NULL means the row still carries the creation placeholder password that can
-- never be logged in with (a never-redeemed account); a timestamp means a real
-- password has been established/changed at that moment. countUsableLoginMethods
-- (packages/auth/src/server/**) reads this to decide whether an account has a
-- usable password, enforcing the lockout invariant (>=1 usable login method).
--
-- Idempotent + forward-only, matching the db-auth migration convention:
--   * ADD COLUMN IF NOT EXISTS so this is a no-op where the column already
--     exists (re-run / historical environments).
--   * BACKFILL existing rows so live admins are NOT falsely flagged
--     placeholder-only. We use `updatedAt` as the best-available proxy for
--     "a password was last set", and only touch rows still NULL so a re-run
--     never clobbers a value a later real password-set wrote.
--
-- ASSUMPTION (single-merchant): at migration time every existing account has a
-- real, usable password. The invite flow that creates `passwordSetAt`-NULL
-- placeholder accounts ships in this SAME change, so no never-redeemed invite
-- can predate this migration. If such a row somehow existed, this backfill
-- would mis-stamp it as password-having (weakening the lockout guard for that
-- one row, recoverable via an OWNER reset) — verify none exist before deploying
-- or NULL it manually afterward. New invites created AFTER this migration stay
-- NULL correctly (createAdminUser writes the placeholder directly, never via
-- setAccountPassword).

ALTER TABLE "web_admin_accounts" ADD COLUMN IF NOT EXISTS "passwordSetAt" TIMESTAMP(3);

UPDATE "web_admin_accounts" SET "passwordSetAt" = "updatedAt" WHERE "passwordSetAt" IS NULL;
