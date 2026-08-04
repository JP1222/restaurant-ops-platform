-- Add SQUARE to the OrderProvider enum (store #2 onboarding; see
-- docs/square-onboarding.md). Additive and reversible-by-omission: nothing yet
-- writes SQUARE, so existing CLOVER/DELIVERECT/DEMO rows are untouched.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent. On PostgreSQL 12+ this is allowed
-- inside Prisma's per-migration transaction because the new value is NOT *used*
-- in this same migration (it is only declared); it becomes usable after commit.
ALTER TYPE "OrderProvider" ADD VALUE IF NOT EXISTS 'SQUARE';
