-- At-most-one bound merchant per Location (follow-up to PR #723, store-aware
-- online ordering). `resolveOrderStore()` (apps/kds-api/src/lib/order-store.ts)
-- routes an online order's menu, pricing, and the CHARGE to a Location's bound
-- CloverMerchant. If a Location ever held two bound merchants the resolver would
-- have to pick one — silently shifting where the customer's money lands. This
-- index makes that ambiguous state unrepresentable in the database; the resolver
-- additionally fails closed if it ever sees it (defense in depth).
--
-- PARTIAL on `WHERE "locationId" IS NOT NULL` so it constrains only BOUND
-- merchants: any number of UNBOUND store-accounts (locationId NULL — e.g. an
-- env-bootstrapped merchant, or one connected but not yet onboarded) may still
-- coexist. A plain UNIQUE would also allow many NULLs in Postgres (NULLs are
-- distinct), but the explicit predicate states the intent ("only bound rows")
-- and is robust to NULLS-NOT-DISTINCT semantics; Prisma's PSL cannot express a
-- partial index, so it lives here as raw SQL and stays outside Prisma's modeled
-- surface (see the note on CloverMerchant.locationId in schema.prisma).
--
-- Safe on existing data: prod holds 1 merchant, UNBOUND (verified 2026-06-16 via
-- the live KDS DB), so zero rows match the predicate and the index builds empty.
-- NOT created CONCURRENTLY because Prisma wraps each migration in a transaction
-- (CONCURRENTLY is illegal there) and the table is tiny, so the brief lock is a
-- non-issue.
CREATE UNIQUE INDEX "clover_merchants_locationId_unique"
    ON "clover_merchants" ("locationId")
    WHERE "locationId" IS NOT NULL;
