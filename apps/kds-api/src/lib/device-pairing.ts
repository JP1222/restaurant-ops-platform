import { randomBytes } from "node:crypto";

import { DEFAULT_TENANT_ID, type KdsDeviceRole } from "@rop/contracts";

import { createDeviceToken } from "./kds-auth.js";
import type { AppServices } from "./services.js";

// Device pairing (ADR-0818 Phase-2b). A manager generates a short-lived one-time
// CLAIM CODE for a store; the physical device opens the pairing link and redeems
// the code for its DURABLE device token (the existing `KdsDeviceToken`, no
// expiry, revoke-only). The long-lived token never travels in the pairing URL.
//
// The claim lives in Redis (TTL-bounded, atomic GETDEL = single-use, replay-safe)
// — NOT a DB column: a Redis blip loses only un-redeemed codes, never a paired
// device, and there is no row to expunge. The `KdsDeviceToken` row is created at
// REDEEM time (so its `tokenHash` is never null and no "pending" rows accumulate).

// Crockford base32 — no ambiguous I/L/O/U. 256 % 32 === 0, so `byte % 32` is
// unbiased. The code is shown grouped "XXXX-XXXX" for read-aloud.
const CLAIM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CLAIM_PREFIX = "kdspair:";

export function generateClaimCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += CLAIM_ALPHABET[bytes[i]! % 32];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// Normalize for lookup: uppercase, strip the cosmetic dash/space/lowercase so a
// hand-typed "k7q2 9f3m" matches the generated "K7Q2-9F3M".
export function claimRedisKey(code: string): string {
  return `${CLAIM_PREFIX}${code.toUpperCase().replace(/[^0-9A-Z]/g, "")}`;
}

type PairClaimEnvelope = {
  merchantId: string;
  label: string;
  role: KdsDeviceRole;
  tenantId: string;
};

// The tenant a device token gets stamped with — reused from the merchant's
// (Phase-1-backfilled) tenant, mirroring merchantBelongsToTenant in kds-auth.ts.
// A null/unknown merchant tenant falls back to the single implicit tenant so
// flipping MULTITENANT_MODE=enforce never rejects an already-paired device.
export async function resolveTenantIdForMerchant(
  prisma: AppServices["prisma"],
  merchantId: string
): Promise<string> {
  const merchant = await prisma.cloverMerchant.findUnique({
    where: { id: merchantId },
    select: { tenantId: true }
  });
  return merchant?.tenantId ?? DEFAULT_TENANT_ID;
}

export async function createPairingClaim(
  services: AppServices,
  input: { merchantId: string; label: string; role: KdsDeviceRole }
): Promise<{ label: string; role: KdsDeviceRole; claimCode: string; pairUrl: string; expiresInSeconds: number }> {
  const tenantId = await resolveTenantIdForMerchant(services.prisma, input.merchantId);
  const claimCode = generateClaimCode();
  const ttl = services.config.pairClaimTtlSeconds;
  const envelope: PairClaimEnvelope = {
    merchantId: input.merchantId,
    label: input.label,
    role: input.role,
    tenantId
  };
  await services.redisPublisher.set(claimRedisKey(claimCode), JSON.stringify(envelope), "EX", ttl);

  const base = (services.config.kdsWebBaseUrl ?? services.config.appBaseUrl).replace(/\/$/, "");
  const pairUrl = `${base}/pair?code=${encodeURIComponent(claimCode)}`;
  return { label: input.label, role: input.role, claimCode, pairUrl, expiresInSeconds: ttl };
}

export type RedeemResult =
  | { ok: true; token: string; deviceId: string; merchantId: string; role: KdsDeviceRole }
  | { ok: false; reason: "invalid_or_expired" };

export async function redeemPairingClaim(services: AppServices, code: string): Promise<RedeemResult> {
  // Atomic one-time: GETDEL returns the value AND deletes it, so a replayed code
  // (or two devices racing one code) yields null for all but the first caller.
  const raw = await services.redisPublisher.getdel(claimRedisKey(code));
  if (!raw) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  let envelope: PairClaimEnvelope;
  try {
    envelope = JSON.parse(raw) as PairClaimEnvelope;
  } catch {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const generated = createDeviceToken();
  const device = await services.prisma.kdsDeviceToken.create({
    data: {
      merchantId: envelope.merchantId,
      label: envelope.label,
      role: envelope.role,
      tenantId: envelope.tenantId,
      tokenHash: generated.tokenHash,
      lastUsedAt: new Date()
    },
    select: { id: true, merchantId: true, role: true }
  });

  return {
    ok: true,
    token: generated.token,
    deviceId: device.id,
    merchantId: device.merchantId,
    role: device.role
  };
}
