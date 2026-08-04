# ADR-0025: Online ordering (order-web) architecture & boundaries

- **Status**: Proposed
- **Date**: 2026-05-30
- **Deciders**: @example-org
- **Related**: [ADR-0003](0003-floor-vs-backoffice-split.md) (product-surface split), [ADR-0021](0021-loyalty-crm-domain.md)/[ADR-0022](0022-loyalty-ledger-and-accrual.md) (loyalty), [ADR-0024](0024-membership-crm-customer-identity.md) (customer identity)

## Context

`apps/order-web` exists on `main` as a **customer-facing online-ordering prototype** — a phone-first, QR-landing flow (browse menu → build a custom roll/drink with modifiers → pickup name/phone/email → pay). It was ported from the standalone `example-org/online-ordering` Vite SPA into the suite's Next.js 16 / React 19 / Tailwind v4 stack (Zustand cart with localStorage), and currently runs entirely on a **mocked, POS-neutral API layer** (`apps/order-web/lib/api.ts`) — the same "frontend prototype on mock data" pattern as `apps/crew-web`. A `compose-dokploy/order.yml` + `Dockerfile` (port 3004) already exist.

What is deliberately **absent** today (verified 2026-05-30): no real backend, no payment SDK, no `@rop/db-*` import (eslint-enforced), no `@rop/contracts` import (DTOs hand-written in `lib/types.ts`), no customer identity, no loyalty/points.

A new product surface with a backend, payment, and a loyalty hookup still to be built is exactly where boundaries drift if left implicit. This ADR records the architecture so the prototype→production wiring stays inside the Iron Laws and reuses existing infrastructure instead of growing a parallel stack.

## Decision

1. **Product placement (Iron Law #4).** order-web is the **customer-facing online-ordering surface** (order-ahead / pickup). It is **not** Floor (`kds-web`, kitchen TVs) and **not** Backoffice (`backoffice-web`, owner/manager). It is a third UX with its own cadence — one customer on their own phone — and must not absorb Floor or Backoffice concerns ([ADR-0003](0003-floor-vs-backoffice-split.md)).

2. **Payment is rented — Clover Hosted Checkout (redirect), SAQ-A.** Card data never touches our servers. **No inline card fields / tokenization on our frontend without a documented PCI review.** The cart's localStorage persistence is required precisely to survive the Hosted-Checkout redirect-back. ("Build the brain, rent the rails" — payment is a rail.)

3. **Orders enter the SAME canonical pipeline — no parallel order store.** A paid online order flows into `kds-api` through the existing ingress → `normalizeOrder` → `syncOrderById` path (the Clover order webhook), tagged by `provider`, so it reaches the KDS exactly like an in-store order. order-web **does not** write to `db-kds` directly (Iron Law #1, already eslint-enforced for this app) and **does not** create its own order database. There is one source of truth for orders.

4. **DTOs migrate to `packages/contracts` when the backend lands (Iron Law #2).** The hand-written `lib/types.ts` is a temporary prototype affordance. When real endpoints exist, the order/menu/status DTOs move into `packages/contracts`; the mocked `lib/api.ts` is the **single swap point** (its method signatures are the contract, so the UI does not change). Hand-written boundary DTOs must not become permanent.

5. **Backend home = `kds-api`'s order pipeline.** Ordering endpoints land in `kds-api` (it already owns Clover + order sync); order-web may add a thin BFF under `app/api/*` (mirroring `crew-web`) for same-origin calls, but the source of truth is kds-api — **no new order-specific database or service** is introduced for this.

6. **Customer + loyalty go through crm-api ([ADR-0024](0024-membership-crm-customer-identity.md)), via the one accrual path ([ADR-0022](0022-loyalty-ledger-and-accrual.md)).** At checkout, the phone resolves/enrolls a `CrmCustomer` in crm-api; order-web holds **no customer table** of its own. Points accrue from the **same** `order.completed` event the in-store flow emits — order-web does **not** get a separate loyalty/accrual path (that would double-count and fragment identity). Showing a balance/progress bar is a read call to crm-api. **Loyalty/CRM availability must never block placing an order** — enrollment and balance are best-effort overlays on top of a checkout that stands on its own.

7. **Menu availability reuses Clover sync.** 86'd / unavailable items come from the existing Clover sync state, so the online menu reflects real-time availability rather than a separate catalog.

## Consequences

- A clean prototype→production path: swap `lib/api.ts` mocks for same-origin fetches, lift DTOs into contracts, point checkout at Hosted Checkout, and online orders appear on the KDS and accrue loyalty with **no new pipeline, no new order DB, no new customer table**.
- Payment liability stays rented (SAQ-A); the suite never holds cardholder data.
- One order pipeline (in-store + online) and one customer identity (online + in-store) — consolidated reporting and loyalty "just work" across channels.
- order-web takes runtime dependencies on kds-api (orders) and crm-api (customer/loyalty); both must degrade gracefully (an order must complete even if loyalty is down).
- Open follow-ups (separate decisions): Clover **Ecommerce API** vs **Hosted Checkout** specifics (fees, settlement, order creation shape); exact ordering-endpoint contract; whether queue-ETA needs a realtime channel vs polling.

## Alternatives considered

- **order-web owns its own database + order table.** Rejected: a second source of truth for orders, crosses Iron Law #1, and forces reconciliation against the KDS. The existing normalize→sync pipeline already turns any provider's order into a KDS ticket.
- **Inline card payment (own the checkout form).** Rejected: explodes PCI scope (SAQ-D), real cardholder-data liability — the opposite of "rent the rails." Hosted Checkout keeps us at SAQ-A.
- **Keep hand-written DTOs permanently.** Rejected: guarantees contract drift between order-web and the backend; Iron Law #2 exists for exactly this.
- **A separate loyalty/accrual path inside order-web.** Rejected: double-accrual risk and a second customer identity; the one-way `order.completed` event ([ADR-0022](0022-loyalty-ledger-and-accrual.md)) is the single accrual path for every channel.
- **Fold online ordering into kds-web or backoffice.** Rejected: conflates a customer surface with Floor/Backoffice ([ADR-0003](0003-floor-vs-backoffice-split.md)) — different users, cadence, and error tolerance.

## Future work (out of scope here)

- The ordering-endpoint contract in `packages/contracts` and the kds-api routes that back it.
- Clover Ecommerce vs Hosted Checkout decision (fees/settlement/PCI), as its own ADR.
- Wiring the loyalty progress/redeem overlay (after crm-api read APIs land, Phase 3+ of the loyalty plan).
