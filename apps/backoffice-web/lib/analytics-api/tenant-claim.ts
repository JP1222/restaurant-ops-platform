import { cookies } from "next/headers";

import { signAnalyticsTenantClaim } from "@rop/contracts/tenant-claim";

import { getBackofficeSessionCookieName } from "@/lib/auth/config";
import { getBackofficeAuthService } from "@/lib/auth/service";
import { getServerEnv } from "@/lib/env";

// Multi-tenant (ADR-0818 Phase 2c): the backoffice BFF mints the signed
// AnalyticsTenantClaim that analytics-api verifies, replacing the
// `?merchant_id=`-behind-shared-token trust. Server-only (reads the session
// cookie via the Next request scope, like resolveAnalyticsMerchantId).

const CLAIM_TTL_SECONDS = 60;

// Resolve the active session's tenant — request-less, mirroring
// lib/location/scope.ts. Returns null when there is no session (so no claim is
// minted; an enforce-mode analytics then fails the call closed).
async function resolveSessionTenantId(): Promise<string | null> {
  const jar = await cookies();
  const sessionId = jar.get(getBackofficeSessionCookieName())?.value;
  if (!sessionId) {
    return null;
  }
  const session = await getBackofficeAuthService().readSession(sessionId);
  return session?.tenantId ?? null;
}

/**
 * Mint a short-lived signed tenant claim for an analytics read, or null to send
 * none. Null (the default) whenever ANALYTICS_TENANT_SIGNING_KEY is unset — so
 * the minter is dormant and analytics stays in its off-mode until the operator
 * configures the key for the observe→enforce rollout. The key check runs FIRST,
 * so the dormant path never touches the session/cookie machinery.
 *
 * `merchantIds` carries the request's store (advisory — analytics authoritatively
 * checks the merchant against its own sync_targets.tenant_id); empty for the
 * default-store path.
 */
export async function mintAnalyticsTenantClaim(merchantId: string | undefined): Promise<string | null> {
  const key = getServerEnv().ANALYTICS_TENANT_SIGNING_KEY;
  if (!key) {
    return null;
  }

  let tenantId: string | null = null;
  try {
    tenantId = await resolveSessionTenantId();
  } catch {
    // Called outside a request scope, or the session read failed — mint nothing.
    return null;
  }
  if (!tenantId) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  return signAnalyticsTenantClaim(
    {
      tenantId,
      merchantIds: merchantId ? [merchantId] : [],
      iat: now,
      exp: now + CLAIM_TTL_SECONDS
    },
    key
  );
}
