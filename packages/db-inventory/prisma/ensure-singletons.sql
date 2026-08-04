-- Idempotent self-heal for the two singleton config rows (ADR-0028 follow-up).
--
-- The inventory deploy pipeline runs `prisma migrate deploy` (schema-only) with
-- no seed step, so a fresh / reset inventory DB comes up schema-present but
-- row-empty. inventory-api's serialize.ts + inventory-store.ts then throw
-- "not initialized: missing waste_settings/metrics singleton" on GET
-- /api/inventory, surfacing as a Backoffice "Couldn't load inventory" outage.
--
-- This script guarantees the two singletons exist after every migrate, so an
-- empty DB serves a valid (empty-catalog) dataset instead of a 500. It is the
-- minimal functional floor, NOT a catalog seed: real items/recipes/vendors are
-- the operator's data, entered via the editor. ON CONFLICT DO NOTHING means it
-- NEVER overwrites operator-configured values — safe to run on every deploy.
INSERT INTO inventory_waste_settings (id, photo_required_over_cents, manager_approval_over_cents)
VALUES ('singleton', 2500, 5000)
ON CONFLICT (id) DO NOTHING;

-- Food-cost target benchmark only; the COGS / net-sales trend columns were
-- dropped (ADR-0573) — those measurements are analytics-owned (Iron Law 5).
INSERT INTO inventory_metrics (id, cogs_target_pct)
VALUES ('singleton', 0)
ON CONFLICT (id) DO NOTHING;
