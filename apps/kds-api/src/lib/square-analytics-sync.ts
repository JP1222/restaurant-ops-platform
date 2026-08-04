import type { FastifyBaseLogger } from "fastify";
import type { SquareConnectStore } from "@rop/contracts";

import type { AppConfig } from "../config.js";

const PUSH_TIMEOUT_MS = 5_000;

// Register a connected Square store as an analytics sync target (Phase 4 PR-F).
// kds-api decrypts the token and pushes it to analytics over TLS, gated by the
// dedicated KDS_ANALYTICS_PUSH_TOKEN bearer (Iron Law 1: analytics never imports
// db-kds — the credential arrives via this one-way HTTP push, the ADR-0018
// sync_targets pattern). BEST-EFFORT: a missing config or an unreachable
// analytics is logged and swallowed — the store is fully live for KDS regardless,
// and a missed push self-heals (analytics simply won't sync it until the row
// exists; re-running connect / a future rotation re-pushes). NEVER logs the token.
export async function pushSquareSyncTargets(
  config: AppConfig,
  stores: SquareConnectStore[],
  token: string,
  log: FastifyBaseLogger
): Promise<void> {
  if (!config.analyticsInternalUrl || !config.kdsAnalyticsPushToken) {
    log.debug({ scope: "square.analytics-sync" }, "analytics push not configured — skipping sync-target registration");
    return;
  }
  const url = new URL("/admin/api/sync-targets", config.analyticsInternalUrl).toString();
  const tokenLast4 = token.slice(-4);

  for (const store of stores) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.kdsAnalyticsPushToken}`
        },
        body: JSON.stringify({
          merchant_id: store.posStoreId,
          provider: "square",
          token,
          store_timezone: store.timezone,
          active: true
        }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
      });
      if (!response.ok) {
        // Log the coarse status only — never the token or the response body.
        log.warn(
          { scope: "square.analytics-sync", merchantId: store.posStoreId, provider: "square", status: response.status, tokenLast4 },
          "analytics sync-target registration failed (non-fatal)"
        );
        continue;
      }
      log.info(
        { scope: "square.analytics-sync", merchantId: store.posStoreId, provider: "square", tokenLast4 },
        "registered Square store as analytics sync target"
      );
    } catch (err) {
      log.warn(
        {
          scope: "square.analytics-sync",
          merchantId: store.posStoreId,
          provider: "square",
          tokenLast4,
          err: err instanceof Error ? err.message : "unknown"
        },
        "analytics sync-target push errored (non-fatal)"
      );
    }
  }
}
