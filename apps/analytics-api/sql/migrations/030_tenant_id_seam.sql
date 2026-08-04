-- Multi-tenant Phase 1 (ADR-0818): additive `tenant_id` seam on the analytics OLAP.
--
-- Example Kitchen is becoming a Toast-style multi-tenant platform
-- (Tenant -> Location -> Device). `tenant_id` is the hard trust boundary;
-- `merchant_id`/`location_id` are partition keys *underneath* it. This migration
-- is the analytics half of the suite-wide Phase-1 column seam already landed on
-- db-kds (Tenant entity + operational tables), db-inventory, and db-crm.
--
-- STAGING RULE (roadmap step 3, identical to the Prisma seam PRs): this is an
-- ADDITIVE, zero-behavior-change step. We only ADD the nullable column and
-- BACKFILL it to the single implicit tenant (`tenant-default`, matching the
-- `Tenant` row seeded in db-kds). NOTHING reads `tenant_id` yet:
--   * The read path still selects a store via `?merchant_id=` (the signed
--     tenant claim that closes that hole is Phase 2 -- `tenant-auth.ts`).
--   * The loader (`src/transform/mart-loader.ts`) does not write `tenant_id`
--     yet, so rows ingested AFTER this migration carry NULL until the Phase-2
--     loader change -- the same "backfilled-then-NULL-tail" shape as
--     db-inventory's trigger-inserted cost-history rows. Harmless while nothing
--     filters on it.
--   * No indexes, no NOT NULL, no tenant-leading unique/PK reworks here. Those
--     land in Phase 2/3 alongside the read-path + RLS work, when the access
--     patterns are known (deferred exactly as the db-kds operational seam did).
--
-- SCOPE -- tenant-owned persistent base tables only:
--   * raw.*            (Clover + Square ingest)
--   * mart dims        (excluding mart.dim_calendar -- a universal date
--                       dimension, identical for every tenant, so global)
--   * mart facts       (partitioned parents only; ADD COLUMN cascades to the
--                       `_default` partitions automatically -- adding to a
--                       partition child directly would error)
--   * mart forecast tables
--   * config.sync_targets (per-store sync config)
--
-- DELIBERATELY EXCLUDED:
--   * The 9 mart materialized views (sales_daily_mv, sales_hourly_mv,
--     item_sales_daily_mv, payment_method_daily_mv, employee_sales_daily_mv,
--     item_sales_hourly_mv, cost_daily_mv, prime_cost_daily_mv,
--     cost_variance_daily_mv). MVs are DERIVED -- you cannot ADD COLUMN to one;
--     they would have to be DROP/CREATEd with `tenant_id` in the SELECT list,
--     which is a read-path change, not zero-behavior. They gain `tenant_id` in
--     Phase 2 when the read path (and the MV definitions) start filtering by it.
--     Adding the column to their base tables here does NOT affect the MVs (their
--     column lists are fixed) and REFRESH continues to work unchanged.
--   * meta.metric_definitions -- the governed semantic registry (ADR-0030); the
--     metric definitions are global, identical across tenants.
--   * audit.* -- operational pipeline state (sync jobs, heartbeats, DQ checks,
--     webhook inbox, recon). Not the OLAP mart; written/read by the service
--     role, not tenant-facing reads. Revisited with the Phase-3 RLS work.

-- ── raw.* ingest ─────────────────────────────────────────────────────────────
ALTER TABLE raw.clover_employees   ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.clover_exports     ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.clover_order_types ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.clover_orders      ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.clover_payments    ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.clover_refunds     ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.clover_tenders     ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.square_orders      ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.square_payments    ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE raw.square_refunds     ADD COLUMN IF NOT EXISTS tenant_id text;

-- ── mart dimensions (dim_calendar excluded -- universal/global) ───────────────
ALTER TABLE mart.dim_employee   ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.dim_item       ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.dim_order_type ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.dim_tender     ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.dim_item_cost  ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.dim_labor_cost ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.dim_actual_cogs ADD COLUMN IF NOT EXISTS tenant_id text;

-- ── mart facts (partitioned parents; cascades to `_default` partitions) ───────
ALTER TABLE mart.fact_orders             ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.fact_order_line_items   ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.fact_payments           ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.fact_refunds            ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.fact_line_item_modifiers ADD COLUMN IF NOT EXISTS tenant_id text;

-- ── mart forecast ────────────────────────────────────────────────────────────
ALTER TABLE mart.forecast_daily    ADD COLUMN IF NOT EXISTS tenant_id text;
ALTER TABLE mart.forecast_backtest ADD COLUMN IF NOT EXISTS tenant_id text;

-- ── config.sync_targets (per-store sync config) ──────────────────────────────
ALTER TABLE config.sync_targets ADD COLUMN IF NOT EXISTS tenant_id text;

-- ── Backfill the single implicit tenant ──────────────────────────────────────
-- One UPDATE per table; `WHERE tenant_id IS NULL` keeps it idempotent. The fact
-- UPDATEs write through to every partition automatically.
UPDATE raw.clover_employees   SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.clover_exports     SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.clover_order_types SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.clover_orders      SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.clover_payments    SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.clover_refunds     SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.clover_tenders     SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.square_orders      SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.square_payments    SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE raw.square_refunds     SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;

UPDATE mart.dim_employee    SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.dim_item        SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.dim_order_type  SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.dim_tender      SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.dim_item_cost   SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.dim_labor_cost  SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.dim_actual_cogs SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;

UPDATE mart.fact_orders              SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.fact_order_line_items    SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.fact_payments            SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.fact_refunds             SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.fact_line_item_modifiers SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;

UPDATE mart.forecast_daily    SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
UPDATE mart.forecast_backtest SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;

UPDATE config.sync_targets SET tenant_id = 'tenant-default' WHERE tenant_id IS NULL;
