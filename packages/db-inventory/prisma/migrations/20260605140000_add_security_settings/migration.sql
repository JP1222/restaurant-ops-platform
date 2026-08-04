-- Floor-auth security settings (manager-tunable, no redeploy).
--
-- Singleton table (mirrors inventory_waste_settings). Today holds just the crew
-- login IP allowlist: free-text single IPs / IPv4 CIDRs that may reach the crew
-- PIN login. Empty string = allow all (the gate is opt-in, so a blank value never
-- locks the floor out). Enforced in crew-web's BFF (the only tier that sees the
-- cook's real client IP via X-Forwarded-For now that inventory-api is
-- internal-only); edited from Backoffice.
--
-- Additive + safe on live data: brand-new table, no change to existing rows. The
-- store defaults to allow-all when the row is absent, so no seed row is required.
-- Rollback: drop the table.

-- CreateTable
CREATE TABLE "inventory_security_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "crew_ip_allowlist" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_security_settings_pkey" PRIMARY KEY ("id")
);
