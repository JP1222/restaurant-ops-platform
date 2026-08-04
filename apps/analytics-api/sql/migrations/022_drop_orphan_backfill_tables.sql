-- Drop the orphan one-shot-backfill bookkeeping tables.
--
-- `audit.backfill_runs` / `audit.backfill_windows` were created in 001_init.sql
-- for the standalone `runBackfill()` engine (src/backfill/runner.ts). That engine
-- was never wired into the running service: nothing imported `runBackfill`, and
-- prod had zero rows in either table (verified read-only on
-- rop-analytics-postgres-analytics-1 before this migration). The live
-- historical-backfill path is the scheduler-driven `historical_export_backfill`
-- job, whose per-window state lives in `audit.sync_windows`. See ADR-0642
-- (docs/decisions/0642-autonomous-scheduler-is-the-one-backfill-implementation.md).
--
-- Forward-only. There is no down migration and no data to preserve.
-- Order matters: backfill_windows.run_id FK-references backfill_runs, so the
-- dependent table is dropped first.
DROP TABLE IF EXISTS audit.backfill_windows;
DROP TABLE IF EXISTS audit.backfill_runs;
