-- Drop the seeded COGS / net-sales trend arrays from the inventory_metrics
-- singleton (ADR-0573). These held fabricated daily measurements; the real
-- COGS / net-sales figures are analytics-owned (Iron Law 5) and now read live
-- from analytics-api's metric registry. The food-cost target benchmark
-- (cogs_target_pct) is config and stays.
--
-- Forward-only, non-destructive to operator data: the dropped columns only ever
-- carried demo-seed values (dev seed) or empty arrays (ensure-singletons.sql on a
-- fresh prod DB). No app reads them after this migration.
ALTER TABLE "inventory_metrics" DROP COLUMN IF EXISTS "cogs_trend";
ALTER TABLE "inventory_metrics" DROP COLUMN IF EXISTS "net_sales_trend";
