import { EventEmitter } from "node:events";

import type { Notification as NotificationDto } from "@rop/contracts";

// In-process pub/sub for realtime notification fanout (notifications realtime, the
// successor to the 30s backoffice poll). The ingest endpoint publishes each
// newly-created notification; the SSE stream endpoint subscribes and pushes it to
// every connected operator, so the bell updates the moment a producer fires.
//
// SINGLE-PROCESS ONLY. notifications-api runs as one instance (internal-only, no
// worker — see AGENTS.md), so an in-memory emitter reaches every live SSE
// connection. When this service scales to multiple processes, the bus must move to
// Redis pub/sub (or equivalent) so a notification ingested on one process reaches
// SSE clients on another — the same single-process caveat the crew-auth rate
// limiter carries. Until then, in-memory is correct and dependency-free.
export class NotificationBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE connection; the default 10-listener warning would
    // misfire as connections accumulate. 0 = unlimited.
    this.emitter.setMaxListeners(0);
  }

  /** Fan a newly-created notification out to every current subscriber. */
  publish(notification: NotificationDto): void {
    this.emitter.emit("notification", notification);
  }

  /**
   * Subscribe to new notifications. Returns an unsubscribe function the caller MUST
   * invoke when its SSE connection closes, so a disconnected client's listener never
   * leaks.
   */
  subscribe(listener: (notification: NotificationDto) => void): () => void {
    this.emitter.on("notification", listener);
    return () => {
      this.emitter.off("notification", listener);
    };
  }

  /** Open SSE connections (one listener each) — for health/observability. */
  subscriberCount(): number {
    return this.emitter.listenerCount("notification");
  }
}
