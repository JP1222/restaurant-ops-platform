-- Align kds_realtime_states.merchantId, kds_provider_events.merchantId, and
-- kds_realtime_events.merchantId from VARCHAR(32) to TEXT, matching the
-- schema.prisma declaration (plain `String`, no @db.VarChar).
--
-- 20260424_realtime_pipeline_hardening created these columns as VARCHAR(32) to
-- match the FK target clover_merchants.id (which is @db.VarChar(32)). The schema
-- declaration was later relaxed to plain `String` (TEXT) without a follow-up
-- migration, leaving the migration history out of sync with schema.prisma.
-- Production was hand-aligned to TEXT, so this migration is forward-only and
-- a no-op on databases that already match the target.
--
-- VARCHAR(N) -> TEXT is a binary-compatible change in Postgres: no row rewrite,
-- and PK / FK constraints survive the ALTER without being dropped and recreated.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'kds_realtime_states'
      AND column_name = 'merchantId'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE "kds_realtime_states" ALTER COLUMN "merchantId" SET DATA TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'kds_provider_events'
      AND column_name = 'merchantId'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE "kds_provider_events" ALTER COLUMN "merchantId" SET DATA TYPE TEXT;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'kds_realtime_events'
      AND column_name = 'merchantId'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE "kds_realtime_events" ALTER COLUMN "merchantId" SET DATA TYPE TEXT;
  END IF;
END
$$;
