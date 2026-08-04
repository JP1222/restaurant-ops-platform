-- ADR-0029: migrate existing admins to OWNER and make OWNER the column default.
--
-- Safe only AFTER 20260601_web_admin_role_add_values has committed (it adds the
-- 'OWNER' enum value this migration consumes). Idempotent: re-running flips no
-- additional rows once every ADMIN has become OWNER.
--
-- 'ADMIN' is intentionally left in the enum type as a deprecated value; a later
-- enum-cleanup migration may drop it once no environment references it.
UPDATE "web_admin_accounts" SET "role" = 'OWNER' WHERE "role" = 'ADMIN';

ALTER TABLE "web_admin_accounts" ALTER COLUMN "role" SET DEFAULT 'OWNER';
