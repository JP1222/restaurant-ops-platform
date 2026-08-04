-- ADR-0029: expand WebAdminRole for the federated RBAC model.
--
-- Enum-value additions MUST land in their own migration, separate from any
-- statement that USES the new values: PostgreSQL forbids using a freshly-added
-- enum value in the same transaction that added it. The data migration that
-- consumes 'OWNER' lives in the next migration (..._web_admin_role_set_default),
-- which runs in a later transaction once these values are committed.
--
-- IF NOT EXISTS keeps this idempotent across the historical environments
-- described in the db-auth baseline migration.
ALTER TYPE "WebAdminRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "WebAdminRole" ADD VALUE IF NOT EXISTS 'MANAGER';
