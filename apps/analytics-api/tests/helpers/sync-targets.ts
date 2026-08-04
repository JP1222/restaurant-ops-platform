import type { SyncTarget, SyncTargetsReader } from "../../src/sync-targets/repository.js";

const DEFAULT_TARGET: SyncTarget = {
  merchantId: "merchant1",
  provider: "clover",
  token: "test-token",
  storeTimezone: "America/Chicago",
  active: true
};

// Lightweight SyncTargetsReader for unit tests — no DB. Defaults to a single
// active "merchant1" target so the prior single-store test behavior is preserved.
export function fakeSyncTargets(targets: SyncTarget[] = [DEFAULT_TARGET]): SyncTargetsReader {
  return {
    loadActive: async () => targets.filter((target) => target.active),
    get: async (merchantId) => targets.find((target) => target.merchantId === merchantId) ?? null,
    isActive: async (merchantId) =>
      targets.some((target) => target.merchantId === merchantId && target.active),
    timezoneFor: async (merchantId, fallback) =>
      targets.find((target) => target.merchantId === merchantId)?.storeTimezone ?? fallback
  };
}
