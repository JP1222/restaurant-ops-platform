# ADR-0642: Autonomous scheduler is the one backfill implementation

- **Status**: Accepted
- **Date**: 2026-06-13
- **Deciders**: @example-org

## Context

`apps/analytics-api` carried **two** historical-backfill code paths:

1. **The live one** — scheduler-driven. `src/scheduler/scheduler.ts` enqueues a
   `historical_export_backfill` job per time window (windows planned by
   `src/backfill/windows.ts`), `src/scheduler/job-runner.ts` runs it via
   `src/jobs/export-reconcile.ts`, and per-window state (pending / running /
   completed / failed / blocked, retry timing, failure counts) is checkpointed in
   `audit.sync_windows`. The ops dashboard (`src/http/dashboard.ts`,
   `historicalBackfillSummary`) reads that same table. This path is autonomous,
   resumable, multi-location aware (ADR-0018), and rate-limit aware.

2. **A dead one-shot runner** — `src/backfill/runner.ts` (`runBackfill()`), a
   single sequential loop that wrote its own bookkeeping to `audit.backfill_runs`
   and `audit.backfill_windows` (both created in `sql/migrations/001_init.sql`).
   It also redefined a `refreshMaterializedViews` that shadowed the real one in
   `src/refresh/mv-refresh.ts`.

The second path had **zero callers** — `grep -rn "runBackfill|backfill/runner"`
across `apps/` and `packages/` matched only the definition itself. Its tables
were never written by the running service: a read-only check on the prod
analytics database (`rop-analytics-postgres-analytics-1`) returned **0
rows** in both `audit.backfill_runs` and `audit.backfill_windows`. The only thing
referencing those tables besides the dead runner was one integration test that
used `backfill_runs` merely as a convenient "write a row, read it back" target.

Two implementations of the same capability — one live and battle-tested, one
dead — is exactly the kind of drift the Iron Laws guard against: a future agent
could "fix a bug" in or wire up the wrong one, or trust orphan tables as a data
source. This is Phase 4 / problem P3 of the backfill remediation.

## Decision

Treat the **scheduler-driven `historical_export_backfill` job as the single,
canonical backfill implementation**, and delete the dead one-shot path entirely:

- Delete `src/backfill/runner.ts` (and the now-orphan `BackfillMode` type that
  only it used).
- **Keep** `src/backfill/windows.ts` — it is live, imported by the scheduler and
  the ops dashboard for window-planning math.
- Drop the orphan tables `audit.backfill_runs` and `audit.backfill_windows` via a
  forward-only migration (`sql/migrations/022_drop_orphan_backfill_tables.sql`),
  after confirming both are empty on prod.
- Repoint the one integration test that used `backfill_runs` at a surviving
  defaulted audit table (`audit.ai_query_log`); it still proves the same thing
  (write → read a DB-side default → truncate clears data but preserves the
  migration ledger).

## Consequences

- **Easier:** one backfill path to reason about, test, and operate. No shadowed
  `refreshMaterializedViews`. New contributors can't accidentally adopt or "fix"
  a dead engine, and can't mistake empty orphan tables for a real data source.
- **Schema is forward-only:** the DROP has no down migration. This is safe
  because the tables held no data anywhere (prod verified, and they were never a
  read source). Migrations in this package are forward-only by design
  (`AGENTS.md`).
- **Lost capability — none operationally, by design.** `runBackfill()` offered a
  manual `sample`/`full`/`custom` one-shot. Nothing invoked it; the scheduler
  already covers the full historical range autonomously with resumable,
  rate-limited windows. If an ad-hoc bounded re-import is ever needed, the right
  move is to enqueue `historical_export_backfill` jobs for the target windows (or
  reset their `audit.sync_windows` rows), not to resurrect a parallel engine.

## Alternatives considered

- **Do nothing (keep the dead code).** Rejected: dead code with its own orphan
  tables is a standing trap — it invites mis-wiring, drifts from the live path,
  and the unread tables masquerade as state. Cost of carrying it is strictly
  negative.
- **Keep the runner as a documented "manual backfill" tool.** Rejected: it
  duplicates the scheduler's logic with a worse (non-resumable, single-merchant,
  shadowing) implementation. Maintaining two engines for one capability violates
  the suite's preference for a single source of truth per concern. A genuine
  manual-trigger need is better served by enqueuing the real job.
- **Drop the runner but keep the tables.** Rejected: empty, unread tables with no
  writer are pure liability — `pnpm docs:check` and future readers would still
  have to account for them. Remove the whole dead surface in one change.
