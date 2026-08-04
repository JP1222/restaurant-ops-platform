-- Multi-tenant RLS — db-inventory foundation (ADR-0818 / #902 Phase 1b-i).
-- See docs/architecture/multi-tenant-greenfield-target.md §2.3, §5, §8.
--
-- Reversible, NO behavior change. Three things:
--   (a) normalize the `tenantId` column to snake_case `tenant_id` (it was the lone
--       camelCase column in an otherwise snake_case schema — migration 20260620
--       forgot @map — and the mismatch silently breaks any raw-SQL policy that
--       references `tenant_id`). The column is unused by code, so the rename is
--       invisible to the app; the Prisma field stays `tenantId` via @map.
--   (b) create the non-superuser runtime role `yr_app` + grant it DML.
--   (c) ENABLE + FORCE RLS on every tenant table with a PERMISSIVE policy.
-- The app still connects as the owner here, so every row stays visible. A later
-- slice (1b-iii) tightens the policy to `tenant_id = current_setting('app.tenant_id')`
-- and points the app at `yr_app` — only then is isolation enforced.

-- (a) Normalize tenantId -> tenant_id on every table that still has the camelCase
--     column. Keyed on the column so it is exhaustive and self-limiting.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE public.%I RENAME COLUMN "tenantId" TO tenant_id', t);
  END LOOP;
END $$;

-- (b) Runtime role: non-superuser, cannot bypass RLS, cannot create roles, NOINHERIT.
--     NOLOGIN for now — a per-environment password/LOGIN is provisioned at cutover
--     (1b-iii), kept OUT of the migration so no production credential is hardcoded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'yr_app') THEN
    CREATE ROLE yr_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO yr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO yr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yr_app;

-- Default privileges so tables/sequences created by future (owner-run) migrations
-- are auto-granted to yr_app — a forgotten GRANT on a new table would otherwise make
-- that table error / return zero rows for the whole app once RLS is enforced.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO yr_app;

-- (c) ENABLE + FORCE RLS on every BASE TABLE that carries tenant_id, with a
--     PERMISSIVE policy for now. Keying the loop on the column (not a hand list)
--     guarantees no tenant table is forgotten — a forgotten table is a silent
--     cross-tenant leak. FORCE makes the policy apply to the table owner too.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I USING (true) WITH CHECK (true)', t
    );
  END LOOP;
END $$;
