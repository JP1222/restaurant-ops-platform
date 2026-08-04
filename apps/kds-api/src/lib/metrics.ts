import client from "prom-client";

const { Counter, Gauge, Histogram, register } = client;

function histogram(name: string, help: string, labelNames: string[] = [], buckets?: number[]) {
  return (register.getSingleMetric(name) as client.Histogram<string>) ?? new Histogram({
    name,
    help,
    labelNames,
    buckets: buckets ?? [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
  });
}

function gauge(name: string, help: string, labelNames: string[] = []) {
  return (register.getSingleMetric(name) as client.Gauge<string>) ?? new Gauge({
    name,
    help,
    labelNames
  });
}

function counter(name: string, help: string, labelNames: string[] = []) {
  return (register.getSingleMetric(name) as client.Counter<string>) ?? new Counter({
    name,
    help,
    labelNames
  });
}

export const kdsWebhookAckSeconds = histogram(
  "kds_webhook_ack_seconds",
  "Seconds spent acknowledging provider webhook requests.",
  ["provider"]
);

export const kdsQueueWaitSeconds = histogram(
  "kds_queue_wait_seconds",
  "Seconds a KDS job spent waiting before a worker started it.",
  ["queue", "job_type"]
);

export const kdsWorkerDurationSeconds = histogram(
  "kds_worker_duration_seconds",
  "Seconds spent processing KDS worker jobs.",
  ["queue", "job_type", "status"]
);

export const kdsWebhookToBoardSeconds = histogram(
  "kds_webhook_to_board_seconds",
  "Seconds between provider webhook receipt and realtime publish.",
  ["provider"]
);

export const kdsCloverPosToBoardSeconds = histogram(
  "kds_clover_pos_to_board_seconds",
  "Seconds between Clover webhook receipt and browser board render.",
  ["provider"]
);

export const kdsRealtimeToBrowserSeconds = histogram(
  "kds_realtime_to_browser_seconds",
  "Seconds between realtime publish and browser receipt.",
  ["provider"]
);

export const kdsBoardRenderSeconds = histogram(
  "kds_board_render_seconds",
  "Seconds between browser receipt and render commit.",
  ["provider"]
);

export const kdsCloverRateLimitWaitSeconds = histogram(
  "kds_clover_rate_limit_wait_seconds",
  "Seconds spent waiting for Clover API token buckets.",
  ["bucket"]
);

export const kdsCloverFetchTimeoutsTotal = counter(
  "kds_clover_fetch_timeouts_total",
  "Clover API fetch() calls aborted by AbortSignal.timeout(), labelled by stage.",
  ["stage"]
);

// GH #170: 1 when the most recent boot-time Clover token validation succeeded,
// 0 when it failed. A persistent 0 means the configured token is stale/revoked
// and the merchant will never sync — surfaced at boot rather than at first job.
export const kdsCloverStartupValidationStatus = gauge(
  "kds_clover_startup_validation_status",
  "Result of the boot-time Clover token validation per merchant (0=fail, 1=pass).",
  ["merchant"]
);

// GH #166: total Clover orders pulled across all reconciliation pages, per
// merchant. A merchant whose count repeatedly lands on a page-size multiple is a
// signal the window is wide enough to need (and now gets) pagination.
export const kdsCloverReconOrdersFetchedTotal = counter(
  "kds_clover_recon_orders_fetched_total",
  "Clover modified-orders fetched during reconciliation, summed across pages.",
  ["merchant"]
);

// GH #134: wall-clock duration of a Clover token refresh under the per-merchant
// lock, labelled by outcome. A p99 climbing toward the lock TTL is the early
// warning that a slow network is about to expire the lock mid-refresh.
export const kdsCloverTokenRefreshDurationSeconds = histogram(
  "kds_clover_token_refresh_duration_seconds",
  "Seconds spent refreshing a Clover access token under the per-merchant lock.",
  ["merchant", "outcome"],
  [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60]
);

export const kdsQueueDepth = gauge(
  "kds_queue_depth",
  "Current BullMQ queue depth.",
  ["queue"]
);

export const kdsDlqSize = gauge(
  "kds_dlq_size",
  "Current unresolved KDS dead-letter job count.",
  ["job_type"]
);

export const kdsProviderEnqueueFailuresTotal = counter(
  "kds_provider_enqueue_failures_total",
  "Provider events accepted but not enqueued on the first attempt.",
  ["provider"]
);

// GH #462: a failed job's dead-letter row could not be persisted even after
// retries. This is the last-resort durability signal — a non-zero value means a
// dead job was lost from the DLQ; alert on it.
export const kdsDeadLetterWriteFailuresTotal = counter(
  "kds_dead_letter_write_failures_total",
  "Dead-letter rows that failed to persist after all retries (job lost from the DLQ).",
  ["job_type"]
);

// GH #461: an existing board ticket was removed during sync (the order was
// pulled off the board), labelled by why. `unpaid` = the order's payment state
// regressed to unpaid/voided; `reset_cutoff` = it predates the daily reset.
// Both deletes are intended, but a silent deleteMany meant a paid order
// misclassified as unpaid would vanish from the kitchen with no trail. A
// nonzero `unpaid` rate that correlates with missed orders is the alert signal.
export const kdsOrderBoardRemovedTotal = counter(
  "kds_order_board_removed_total",
  "Existing KDS board tickets removed during sync (an order pulled off the board), labelled by reason.",
  ["provider", "reason"]
);

// GH #129: webhook deliveries dropped as duplicates at the L1 dedup layer
// (clover_webhook_events, keyed on (merchantId, eventId)). A rising rate is
// the operator's signal for provider resend volume — Clover delivers
// at-least-once, so a steady trickle is expected; a spike means retries.
export const kdsCloverWebhookDedupedTotal = counter(
  "kds_clover_webhook_deduped_total",
  "Clover webhook deliveries dropped as duplicates by the eventId dedup layer.",
  ["provider"]
);

export { register as metricsRegister };
