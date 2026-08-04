# ADR-0727: Dead-letter queue replay reuses the Postgres table, not a new BullMQ queue

- **Status**: Proposed
- **Date**: 2026-06-17
- **Deciders**: @example-org

## Context

[GH #124](https://github.com/example-org/restaurant-ops-platform/issues/124) (P0): a kds-api sync/fulfillment job that exhausts its BullMQ retries is dead-lettered to the Postgres `DeadLetterJob` table (`dead_letter_jobs`), but there is no operator tooling to **see** or **replay** those rows. BullMQ's own failed set is ephemeral (`removeOnFail: 5000` in `bullmq-client.ts`), so once evicted, a terminally-failed order sync is recoverable only by hand-querying Postgres and manually reconstructing a job. The issue's stated risk: "Orders can be stuck silently for hours."

The issue's acceptance criteria proposed **a new persistent `kds-dlq` BullMQ queue** for terminally-failed jobs, an auth-gated list+replay API, a depth metric, an alert, and a runbook. The issue is tagged `needs-adr` and "Safe for Claude: NO — needs ADR; impacts queue topology + alerting policy" — hence this ADR.

Two of the five ACs already shipped, which reframes the decision:

- **Metric** — `kds_dlq_size{job_type}` already exists (`routes/metrics.ts`), set per scrape from `deadLetterJob.groupBy(where resolvedAt IS NULL)`.
- **Alert** — `KdsDeadLetterQueueGrowing` (`kds_dlq_size > 10 for 5m`) + the gauge-staleness fix shipped in **PR #722**.

What remains is **operator visibility + replay**. The key architectural question: do we need a *new queue*, or is the existing durable table already the DLQ?

The decisive fact is what `writeDeadLetterForFailedJob` (`lib/queue/handlers.ts`) already persists per row:

```
{ merchantId, jobType: job.name, reason, attempts,
  payload: { queue: job.queueName, jobId, data: <original job data> } }
```

The original **queue name and full job data are already captured**. Replay therefore needs nothing a new queue would add — it can re-enqueue `payload.data` onto `payload.queue` using the existing `SyncQueue`.

## Decision

**The Postgres `DeadLetterJob` table IS the kds dead-letter queue. We do NOT add a separate `kds-dlq` BullMQ queue.** Replay is an auth-gated admin operation that re-enqueues the stored job onto its original queue and marks the row resolved.

1. **No new queue topology.** The durable record is the table (queryable, retained until explicitly resolved, already metered + alerted). A second BullMQ `kds-dlq` queue would duplicate that durable record in a less-queryable store and add a consumer with no clear owner. Rejected.

2. **Three admin endpoints**, behind the existing internal-admin bearer (`createAdminBearerGuard(config.kdsInternalAdminToken)`, the same guard as `/api/admin/*` and the internal sync route #455) — operator-only, never a Floor session:
   - `GET /api/admin/dlq?resolved=false&jobType=&limit=` — list dead-letter rows (newest first, bounded `take`), for the operator to triage. The list view is the immediate value (no more hand-querying Postgres).
   - `POST /api/admin/dlq/:id/replay` — read the row, re-enqueue `payload.data` onto `payload.queue` via `SyncQueue`, set `resolvedAt = now()`. Returns the re-enqueued job id.
   - `POST /api/admin/dlq/:id/resolve` — mark `resolvedAt` **without** replay, for a row the operator has handled out-of-band or judged unreplayable (a permanent contract bug). Keeps the depth metric/alert honest.

3. **Replay is safe because the sync jobs are idempotent.** `syncNormalizedOrder` upserts by a deterministic internal order id and the producer sets an `idempotencyKey` / dedup key, so re-driving a previously-failed (or even already-succeeded) order sync converges rather than double-applying. A replay that fails again simply re-dead-letters (the `failed` handler writes a fresh row), so the table stays the source of truth.

4. **Alerting policy is unchanged** — the `KdsDeadLetterQueueGrowing` rule (PR #722) already covers "depth > 10 for 5m" per job_type. `resolvedAt` (set by replay/resolve) drops the row out of `kds_dlq_size`, so a successful replay clears the alert. No new alerting surface.

5. **Runbook.** A short "DLQ recovery" entry in `OPERATIONS.md`: alert fires → `GET /api/admin/dlq` to triage → fix the upstream cause if systemic → `replay` (transient) or `resolve` (permanent) each row.

**Scope guard:** single-row replay/resolve only. **Bulk replay is deferred** — a "replay all" against the live sync queue is a thundering-herd foot-gun and isn't needed until a single incident dead-letters more rows than an operator will click through.

## Consequences

- **Smaller, lower-risk implementation.** #124 collapses from "new queue + consumer + topology" to three thin admin routes over an existing table + queue (~S–M, no new infra, no new compose service). Implementable in one reviewable PR.
- **One durable record, already observable.** The table is the single source of truth, already exposed via `kds_dlq_size` + the #722 alert + `system-status`'s `recentDeadLetter`. No second store to keep consistent.
- **New capability: an authenticated endpoint re-drives prod sync jobs.** Mitigated by the existing admin-bearer gate (operator-only) + job idempotency. It is an operator action, logged like the other admin routes.
- **Manual, not automatic, redelivery.** We deliberately do not auto-replay — an auto-retry loop on a systemic failure (e.g. a bad Clover token) would hammer the provider. The alert pages a human; the human decides replay vs. resolve. (Auto-replay-with-backoff could be a later ADR if toil proves it out.)
- **Deferred:** bulk replay, and a Backoffice UI for the DLQ (the API is BFF-ready; a UI is Floor-vs-Backoffice product work, not this ADR).

## Alternatives considered

- **New persistent `kds-dlq` BullMQ queue (the issue's literal AC).** Rejected: it duplicates the durable record that the Postgres table already provides, in a store that is harder to query/triage, and adds a consumer with no processing role (a DLQ that nothing drains is just a worse table). The table already captures the original `queue` + `data`, so it loses nothing for replay.
- **Auto-redelivery (re-enqueue on dead-letter with capped retries).** Rejected as the default: a systemic failure (token expiry, Clover outage) would make every job auto-replay into the same wall, amplifying load and log noise. The alert-then-human-decides flow is safer for a single-merchant shop; auto-replay can be revisited if manual toil becomes real.
- **Do nothing (keep hand-querying Postgres).** Rejected: that is the status quo the P0 is about — "orders stuck silently for hours" with recovery requiring DB surgery. The list endpoint alone removes the worst of that toil.
- **Backoffice UI now.** Deferred: the auth-gated API is the boundary; a UI is separable product work and not needed to unblock operator recovery (curl/BFF suffices initially).
