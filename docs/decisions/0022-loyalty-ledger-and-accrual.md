# ADR-0022: Loyalty ledger is append-only; accrual is event-driven, idempotent, and one-way

- **Status**: Proposed
- **Date**: 2026-05-30
- **Deciders**: @example-org
- **Depends on**: [ADR-0021](0021-loyalty-crm-domain.md) (db-crm + crm-api exist)

## Context

The loyalty engine must turn "an order was paid" into "this customer earned N
points" — correctly, exactly once, and reversibly on refund — across an
at-least-once delivery pipeline (Clover webhooks + BullMQ both redeliver; the
nightly `kds-sync-lo` reconcile replays modified orders). Two design forces:

1. **The balance must be auditable and reversible.** A mutable `balance` column
   can't explain itself or cleanly undo a refund.
2. **The "order completed" signal lives in kds-api, the ledger lives in
   crm-api** (separate DBs, [ADR-0021](0021-loyalty-crm-domain.md)). They must
   communicate without sharing a transaction.

**Load-bearing codebase fact (verified 2026-05-30):** the canonical
`NormalizedOrderSchema` (`packages/contracts/src/index.ts:270-284`) and
`NormalizedOrderItemSchema` (`:256-268`) carry **no** total / price / subtotal /
tax — `apps/kds-api/src/domain/normalize-order.ts:103` deliberately drops Clover
line-item price. **The accrual worker cannot compute an earn basis from today's
NormalizedOrder.**

## Decision

### 1. The ledger is append-only / event-sourced

`CrmPointsLedger` is an immutable stream of signed-delta rows
(`EARN +N`, `REDEEM −N`, `REVERSE`, `EXPIRE`, `ADJUST`, `BONUS`). Balance is a
projection, never a primary field.

- **Idempotency** — DB `UNIQUE (source, sourceId, type)` where `sourceId` is the
  Clover internal order id. A replayed accrual INSERT-conflicts into a no-op.
  This constraint is **mandatory**, not optional.
- **PENDING-by-default** — EARN rows insert `status=PENDING` and promote to
  `AVAILABLE` only after the refund/return window. `balancePoints = SUM(points
  WHERE status=AVAILABLE)`. This kills return-after-earn fraud.
- **Reversals are new rows** — a refund posts a signed-negative `REVERSE`
  (`reversesLedgerId → EARN`), never an edit. A still-`PENDING` EARN is cancelled
  in place (`PENDING → REVERSED`). Partial refunds recompute eligible subtotal
  and post a delta.
- **Projection + reconcile** — `CrmLoyaltyAccount.balancePoints` is a cache; a
  reconcile job periodically re-sums the ledger and compares `balanceVersion` to
  detect drift.
- **Provider time** — `occurredAt` uses `order.modifiedAt`, not server time, to
  avoid kds-api/crm-api clock skew.

### 2. Accrual is an event, pushed one-way

At the canonical "order completed" signal — **after** the `$transaction` commits
in `apps/kds-api/src/lib/sync-order.ts:421` (gated by `shouldSkipForUnpaidState`
at `:126`, i.e. `paymentState` PAID — **not** `KdsTicket` COMPLETED, which is
kitchen-done) — kds-api enqueues an `order.completed` job to a **new BullMQ queue
`crm-loyalty-accrual`**:

- **Producer = kds-api, consumer = crm-api. One-way push only** — crm-api never
  pulls order details back from kds-api (that would form a service dependency
  loop). The event payload carries everything the worker needs.
- **Fire-and-forget with a dead-letter fallback** — mirror
  `enqueueFulfillmentWriteBack` (`sync-order.ts:158-189`). A loyalty/crm-api
  outage must **never** stall order sync or the kitchen. (No dead-letter
  alerting exists today — add monitoring.)
- Refund/void webhooks emit a sibling `order.refunded` event → `REVERSE` path.

### 3. NormalizedOrder gains an additive monetary block

Add **optional, nullable** fields so the change is backward-compatible
(Deliverect/demo can omit them) and the engine never re-parses Clover:

- `NormalizedOrderItem.priceCents: int | null`
- `NormalizedOrder.amounts?: { subtotalCents, taxCents, tipCents, totalCents, currency }`

populated at normalization (`normalize-order.ts`) from `rawOrder.lineItems[].price`
+ order totals. The new `order.completed` event DTO and all customer-facing
loyalty DTOs live in a **new `packages/contracts/src/loyalty.ts`**, star-exported
from `index.ts` like `inventory.ts` (Iron Law #2 — no hand-written DTOs at the
crm-api boundary).

> **Contract-sync obligation:** changing `NormalizedOrder` touches the native
> contract surface. The iOS `Generated/Contracts.swift` must be regenerated and
> `scripts/sync-contracts.sh --check` must pass (Iron Law #2, native). Because
> the new fields are optional/additive, they should be a clean additive regen,
> but the regen ships in the **same PR** as the schema change.

## Consequences

- Accrual is correct under at-least-once delivery and reconciliation replays;
  refunds are explainable; the balance is a derived, re-verifiable projection.
- The monetary block is the single load-bearing contract change; it lands in
  Phase 4 with the accrual worker (design doc §6), not earlier, so the contract
  change ships with its consumer.
- Liability is trivially reportable: `SUM(available) × cost-per-point ×
  (1 − breakage)` on the backoffice dashboard.
- crm-api carries one more queue + worker; kds-api gains a small producer hook
  and one new queue. The hook is additive and after-commit, so it cannot affect
  order-sync correctness.

## Alternatives considered

- **Mutable `balancePoints` column, no ledger.** Rejected: can't audit, can't
  cleanly reverse a refund, corrupts under concurrent writes.
- **Synchronous HTTP call kds-api → crm-api at accrual time.** Rejected: couples
  the kitchen's order sync to loyalty availability; a crm-api blip would stall
  sync. Async enqueue + dead-letter is the existing repo pattern.
- **Re-read `rawOrder` in crm-api to get amounts** (avoid the contract change).
  Rejected: leaks Clover-specific JSON shape into crm-api, violating Iron Law #2
  and breaking POS-agnosticism the moment a Toast store appears.
- **Accrue on `KdsTicket` COMPLETED.** Rejected: that's kitchen-done, not paid;
  mis-times accrual and double-counts recalls.

## Future work (out of scope here)

- Redemption (app-side coupon issue/void), the nightly expiry job, and fraud
  velocity guards (design doc §6, Phase 5).
- Live customer balance push (a realtime channel) — deferred; SMS is the v1
  channel.
