// Multi-tenant read-path authorization (ADR-0818 Phase 2c). Replaces the
// "`?merchant_id=` behind one shared admin token" trust on /admin reads with a
// signed tenant claim: the backoffice BFF mints an AnalyticsTenantClaim from the
// authenticated session (HMAC, ANALYTICS_TENANT_SIGNING_KEY), sends it in the
// `x-tenant-claim` header, and this service verifies it AND checks the requested
// merchant belongs to the claim's tenant — using its OWN data
// (config.sync_targets.tenant_id), never trusting the caller's merchant list.
//
// Gated by config.multiTenantMode:
//   off     — no-op (today's behavior; the shared adminToken still gates the route).
//   observe — compute the verdict and LOG a violation, but still serve (a
//             dual-read parity window; confirm in Loki before enforcing).
//   enforce — reject a missing/invalid claim (401) or a cross-tenant merchant (403).
//
// This step changes only AUTHORIZATION (which merchant a caller may name), not
// the SQL: queries still filter on merchant_id. Filtering rows by tenant_id waits
// for the loader to start stamping it (migration 030 rows are still NULL).
import type { IncomingMessage } from "node:http";

import { DEFAULT_TENANT_ID } from "@rop/contracts";
import { verifyAnalyticsTenantClaim } from "@rop/contracts/tenant-claim";

import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger } from "./log.js";

const log = createLogger("tenant-auth");

const CLAIM_HEADER = "x-tenant-claim";

export type TenantScopeResult = { ok: true } | { ok: false; status: number; error: string };

type Violation = { status: number; error: string; reason: string; detail?: Record<string, unknown> };

function readClaimHeader(req: IncomingMessage): string | undefined {
  const header = req.headers[CLAIM_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.length > 0 ? value : undefined;
}

// Verdict-only: returns the violation, or null when the request is in-tenant.
async function evaluate(
  req: IncomingMessage,
  pool: DbPool,
  config: AppConfig,
  merchantId: string
): Promise<Violation | null> {
  const key = config.tenantSigningKey;
  if (!key) {
    // Misconfiguration, not a caller error: enforce can't safely allow anything.
    return { status: 503, error: "tenant_claim_unconfigured", reason: "no-signing-key" };
  }

  const token = readClaimHeader(req);
  if (!token) {
    return { status: 401, error: "tenant_claim_required", reason: "missing-claim" };
  }

  const claim = verifyAnalyticsTenantClaim(token, key, Math.floor(Date.now() / 1000));
  if (!claim) {
    return { status: 401, error: "tenant_claim_invalid", reason: "invalid-claim" };
  }

  // Authoritative check against OUR data: which tenant owns the requested store?
  // A NULL tenant_id is a pre-loader-stamp row → the single implicit tenant
  // (the dual-read rule while one tenant exists). A merchant absent from
  // sync_targets is unknown → cross-tenant (fail closed).
  const { rows } = await pool.query<{ tenant_id: string | null }>(
    "SELECT tenant_id FROM config.sync_targets WHERE merchant_id = $1",
    [merchantId]
  );
  if (rows.length === 0) {
    return {
      status: 403,
      error: "merchant_tenant_mismatch",
      reason: "merchant-not-a-sync-target",
      detail: { claimTenant: claim.tenantId }
    };
  }
  const merchantTenant = rows[0]?.tenant_id ?? DEFAULT_TENANT_ID;
  if (merchantTenant !== claim.tenantId) {
    return {
      status: 403,
      error: "merchant_tenant_mismatch",
      reason: "cross-tenant",
      detail: { merchantTenant, claimTenant: claim.tenantId }
    };
  }

  return null;
}

/**
 * Enforce (or observe) that the request is authorized for `merchantId` under the
 * multi-tenant trust boundary. Call it right after resolving the merchant on an
 * authenticated /admin read. Never throws.
 */
export async function enforceTenantScope(
  req: IncomingMessage,
  pool: DbPool,
  config: AppConfig,
  merchantId: string
): Promise<TenantScopeResult> {
  // Only the two active modes do anything; "off" (and any unset value) is a
  // no-op. The zod schema guarantees one of off/observe/enforce in real config.
  if (config.multiTenantMode !== "observe" && config.multiTenantMode !== "enforce") {
    return { ok: true };
  }

  const violation = await evaluate(req, pool, config, merchantId);
  if (!violation) {
    return { ok: true };
  }

  if (config.multiTenantMode === "observe") {
    log.warn("tenant scope violation (observe — request served)", {
      scope: "analytics.tenant.parity",
      merchantId,
      reason: violation.reason,
      ...violation.detail
    });
    return { ok: true };
  }

  // enforce
  log.warn("tenant scope violation (enforce — request rejected)", {
    scope: "analytics.tenant.enforce",
    merchantId,
    status: violation.status,
    reason: violation.reason,
    ...violation.detail
  });
  return { ok: false, status: violation.status, error: violation.error };
}
