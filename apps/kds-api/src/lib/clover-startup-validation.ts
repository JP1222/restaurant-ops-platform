import type { PrismaClient } from "@rop/db-kds";
import type { AppConfig } from "../config.js";
import { resolveDefaultCloverMerchantId } from "./clover-runtime.js";
import { kdsCloverStartupValidationStatus } from "./metrics.js";

// GH #170: validate the configured Clover token at boot instead of waiting for
// the first sync job to fail. A revoked/stale token then surfaces in logs and
// the readiness probe immediately, so an operator knows to re-auth before any
// orders are silently dropped.

export type CloverStartupValidation =
  | { state: "ok"; merchantId: string; checkedAt: string }
  | { state: "failed"; merchantId: string | null; reason: string; checkedAt: string }
  | { state: "skipped"; reason: string; checkedAt: string };

// Module-level last-known result, read by the /api/ready diagnostic. `null`
// until the first validation runs (e.g. very early in boot).
let lastValidation: CloverStartupValidation | null = null;

export function getCloverStartupValidation() {
  return lastValidation;
}

// Exposed for tests so each case starts from a clean slate.
export function resetCloverStartupValidation() {
  lastValidation = null;
}

type CloverValidator = {
  fetchMerchant(merchantId: string): Promise<unknown>;
};

/**
 * Probe the merchant profile with the configured token. Validation is
 * best-effort and never throws: a failure is recorded (log + metric +
 * readiness state) but must not abort boot, because the operator can still
 * re-auth via the Clover admin once the process is up.
 */
export async function validateCloverTokenAtStartup(
  prisma: Pick<PrismaClient, "cloverMerchant"> & Parameters<typeof resolveDefaultCloverMerchantId>[0],
  config: AppConfig,
  clover: CloverValidator,
  logger: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void }
): Promise<CloverStartupValidation> {
  const checkedAt = new Date().toISOString();
  let merchantId: string | null;

  try {
    merchantId = await resolveDefaultCloverMerchantId(prisma, config, undefined);
  } catch (error) {
    merchantId = null;
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Clover startup validation could not resolve a merchant."
    );
  }

  if (!merchantId) {
    // No merchant configured yet (fresh install / pre-OAuth). Not a failure —
    // there is nothing to validate, so leave the metric unset and report skip.
    lastValidation = {
      state: "skipped",
      reason: "no Clover merchant configured",
      checkedAt
    };
    logger.info({ reason: lastValidation.reason }, "Clover startup validation skipped.");
    return lastValidation;
  }

  try {
    await clover.fetchMerchant(merchantId);
    kdsCloverStartupValidationStatus.set({ merchant: merchantId }, 1);
    lastValidation = { state: "ok", merchantId, checkedAt };
    logger.info({ merchantId }, "Clover startup validation passed.");
    return lastValidation;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    kdsCloverStartupValidationStatus.set({ merchant: merchantId }, 0);
    lastValidation = { state: "failed", merchantId, reason, checkedAt };
    logger.warn({ merchantId, err: reason }, "Clover startup validation failed.");
    return lastValidation;
  }
}
