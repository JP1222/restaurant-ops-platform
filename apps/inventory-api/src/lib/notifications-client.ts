import type { IngestNotificationRequest } from "@rop/contracts";

// Producer client → notifications-api ingest. inventory-api emits operational
// events (an 86) as operator notifications. Only notifications-api writes
// db-notifications (Iron Law 1), so this is an HTTP POST over rop-net,
// validated server-side against the shared `IngestNotificationRequest` contract.

export interface NotificationsEmitterConfig {
  baseUrl?: string | undefined;
  token?: string | undefined;
}

export interface NotificationsEmitter {
  /**
   * Emit a notification. Resolves on success OR when unconfigured (a no-op —
   * dev / not-yet-wired stays quiet); rejects on a network / HTTP failure so the
   * caller can log it. Callers MUST fire-and-forget: a notify failure never blocks
   * the inventory write that triggered it.
   */
  emit(payload: IngestNotificationRequest): Promise<void>;
  /** Whether a baseUrl + token are configured (emit actually sends). */
  readonly configured: boolean;
}

export function createNotificationsEmitter(config: NotificationsEmitterConfig): NotificationsEmitter {
  const configured = Boolean(config.baseUrl && config.token);
  return {
    configured,
    async emit(payload) {
      if (!configured) return; // not wired — no-op
      const url = new URL("/api/notifications/ingest", config.baseUrl);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.token}`
        },
        body: JSON.stringify(payload),
        // Bound the cross-service call so a hung/slow notifications-api can't pile
        // up on the inventory-api event loop (mirrors analytics-client).
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`notifications ingest ${response.status}: ${body.slice(0, 200)}`);
      }
    }
  };
}
