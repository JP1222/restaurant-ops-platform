// Internal cross-service tenant claim (ADR-0818, Phase 2c). A short-lived,
// HMAC-SHA256-signed `AnalyticsTenantClaim` that the backoffice BFF mints from
// the authenticated session and analytics-api verifies, replacing the
// `?merchant_id=`-behind-a-shared-token trust on the analytics read path.
//
// WHY IT LIVES IN contracts (not packages/auth, the nominal home for
// cross-service signing): it must be importable by BOTH the backoffice and the
// analytics service, and contracts is the only shared package whose Docker image
// BOTH already build. Importing @rop/auth into analytics-api dragged its
// transitive deps (argon2 native, db-auth/prisma) into the analytics image and
// broke the build (the tenant-claim helper itself needs none of them). It is
// dependency-free (node:crypto + the AnalyticsTenantClaim schema, which lives in
// this package anyway), so it is a clean fit here as a server-only subpath
// (`@rop/contracts/tenant-claim`) kept OFF the main barrel so browser
// bundles never pull node:crypto.
//
// Wire format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payload))>`.
// Symmetric: the same `ANALYTICS_TENANT_SIGNING_KEY` shared secret signs and
// verifies, consistent with the suite's other internal bearers.
import { createHmac, timingSafeEqual } from "node:crypto";

import { AnalyticsTenantClaimSchema, type AnalyticsTenantClaim } from "./tenant.js";

function hmac(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Sign a claim into a `<payload>.<sig>` token. Caller sets `iat`/`exp`. */
export function signAnalyticsTenantClaim(claim: AnalyticsTenantClaim, key: string): string {
  const payload = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
  return `${payload}.${hmac(payload, key)}`;
}

/**
 * Verify a token's signature, decode + schema-validate the claim, and reject an
 * expired one (`exp <= nowSeconds`). Returns the claim or null — NEVER throws and
 * never returns a partial/untrusted value, so callers fail closed on null. The
 * signature is compared in constant time.
 */
export function verifyAnalyticsTenantClaim(
  token: string,
  key: string,
  nowSeconds: number
): AnalyticsTenantClaim | null {
  if (!token || !key) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return null;
  }
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(payload, key));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = AnalyticsTenantClaimSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.exp <= nowSeconds) {
    return null;
  }
  return parsed.data;
}
