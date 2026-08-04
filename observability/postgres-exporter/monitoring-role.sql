-- Read-only monitoring role for postgres_exporter (observability stack, Task 1).
--
-- Run ONCE per database cluster the exporter scrapes — postgres-kds,
-- postgres-analytics, postgres-inventory. postgres_exporter needs only
-- pg_monitor: a built-in role (PostgreSQL 10+) granting read access to the
-- pg_stat_*, pg_ls_* and related monitoring views WITHOUT any access to table
-- data. This is the least-privilege role the HANDOFF calls for.
--
-- Apply (from the Oracle host), once per cluster:
--   docker exec -i rop-kds-postgres-kds-1 \
--     psql -U <superuser> -d <db> -f - < observability/postgres-exporter/monitoring-role.sql
--   docker exec -i rop-analytics-postgres-analytics-1 psql -U <superuser> -d <db> -f - < ...
--   docker exec -i rop-inventory-postgres-inventory-1 psql -U <superuser> -d <db> -f - < ...
--
-- Then put the resulting DSN in the host .env.observability (NOT committed):
--   POSTGRES_KDS_EXPORTER_DSN=postgresql://monitoring:<password>@postgres-kds:5432/<db>?sslmode=disable
--   POSTGRES_ANALYTICS_EXPORTER_DSN=postgresql://monitoring:<password>@postgres-analytics:5432/<db>?sslmode=disable
--   POSTGRES_INVENTORY_EXPORTER_DSN=postgresql://monitoring:<password>@postgres-inventory:5432/<db>?sslmode=disable
--
-- sslmode=disable is correct here: traffic stays on the internal rop-net
-- bridge and never leaves the host.

-- Replace the password before running. Use a strong, unique value per cluster.
CREATE ROLE monitoring WITH LOGIN PASSWORD 'CHANGE_ME_PER_CLUSTER';
GRANT pg_monitor TO monitoring;

-- Postgres grants CONNECT to PUBLIC by default, so the exporter can already
-- connect to the DB named in its DSN. If a hardening pass has revoked CONNECT
-- from PUBLIC, grant it explicitly (replace <db>):
--   GRANT CONNECT ON DATABASE "<db>" TO monitoring;
