# CRM API Agents

`apps/crm-api` is the Fastify backend that owns the **loyalty / CRM** domain (customers, loyalty accounts, the append-only points ledger, rewards, redemptions, referrals). It owns its own Postgres via `packages/db-crm` (`CRM_DATABASE_URL`) and is the **only** app that imports `@rop/db-crm` (Iron Law 1, eslint-enforced — [ADR-0021](../../docs/decisions/0021-loyalty-crm-domain.md)).

It is POS-agnostic: it accrues from the canonical normalized order (Phase 4), never a Clover-specific shape. Customer surfaces (`order-web`, `marketing-site`) and the operator surface (`backoffice-web`) call it over HTTP; none of them touch db-crm.

Use these checks when relevant:

- `pnpm --filter @rop/crm-api build`
- `pnpm --filter @rop/crm-api test`
- `pnpm --filter @rop/crm-api lint`
- `pnpm --filter @rop/crm-api dev` # HTTP API, http://localhost:4200
- `pnpm --filter @rop/crm-api dev:worker` # loyalty-accrual worker (needs CRM_REDIS_URL)

## Routes (Phase 3 — read APIs + enroll)

- `GET  /api/health`, `GET /api/ready`
- `GET  /api/loyalty/rewards` — **public** reward catalog (active `CrmReward` rungs, cheapest first).
- `POST /api/loyalty/enroll` — body `{ phone, displayName?, email?, birthMonth?, marketingSmsConsent? }`. Idempotent by phone (returns the existing member, never a duplicate). 201 on create, 200 on existing. Bearer-only.
- `GET  /api/loyalty/balance?phone=` — cached projection (balance/pending/lifetime). Bearer-only.
- `GET  /api/loyalty/history?phone=&limit=` — redacted ledger rows, newest first. Bearer-only.
- `GET  /api/loyalty/cohorts` — **aggregate-only** guest RFM cohorts for the backoffice `/guests` page (segment counts + cents, new-vs-returning). No phone/name leaves crm-api. RFM is computed in `domain/rfm.ts` (pure); monetary + recency read the `CrmLoyaltyAccount` projection, frequency is one groupBy over spend-derived `EARN` ledger rows. Bearer-only.

## Rules

- **Phone is the single customer identity** ([ADR-0024](../../docs/decisions/0024-membership-crm-customer-identity.md)). Normalize every inbound number through `domain/phone.ts` (`normalizeE164`) — the one chokepoint — before any DB read/write. Reject (400) when it can't be canonicalized rather than mis-keying a customer.
- **Enrollment + PII reads (balance/history) are bearer-only** (`CRM_INTERNAL_TOKEN`, the trusted BFF). The reward catalog is the only public route. Customer-session auth (SMS OTP) is a later phase; until then PII never goes straight to a browser. Fails closed in production when no token is configured.
- **The points ledger (`CrmPointsLedger`) is append-only** ([ADR-0022](../../docs/decisions/0022-loyalty-ledger-and-accrual.md)). Reads here never sum the ledger — they read the cached projection on `CrmLoyaltyAccount`. Writes that earn/redeem/reverse come in later phases and must INSERT signed-delta rows, never UPDATE a balance.
- **Phase-3 DTOs live in `src/domain/dto.ts`, not `packages/contracts`** — no cross-app consumer calls crm-api yet, so they haven't crossed an app boundary. They migrate to `packages/contracts/src/loyalty.ts` when the first consumer lands (Phase 6), per the [ADR-0025](../../docs/decisions/0025-online-ordering-architecture.md) prototype-DTO rule.
- **Points carry no cash value** ([ADR-0023](../../docs/decisions/0023-loyalty-points-legal-posture.md)); never convert them to gift-card value or cash.
- Structured logging only; **never log phone numbers, PII, or bearer tokens**.

## Domain

- `domain/earn.ts` — the pure earn engine (`calculatePointsEarned`), promoted from the Phase-1 design spike. No I/O.
- `domain/accrual.ts` — `accrueFromOrderCompleted(prisma, event)`: turns an `OrderCompletedEvent` into ledger movement **exactly once**. Earn = a PENDING `EARN` row + projection bump in one transaction, idempotent via `UNIQUE(source,sourceId,type)` (a replay conflicts → rolls back, no double-credit). Refund = cancel a still-PENDING earn in place, or post a negative `REVERSE` row against a promoted one. The `OrderCompletedEvent` + `EarnLine` DTOs now live in `@rop/contracts` (migrated in P4b, ADR-0025); `accrual.ts` / `earn.ts` re-export them so their import surface is unchanged. **Partial refunds are not yet modelled** (full-order reverse only) — a Phase-5 follow-up.

## Worker

`src/worker.ts` is a **standalone** BullMQ worker — its own process / compose service, **never** started by the HTTP `index.ts` (mirrors kds-api: HTTP and worker scale + fail independently). It consumes the `crm-loyalty-accrual` queue kds-api produces to; `src/worker-handler.ts` (`processAccrualJob`) validates the payload, canonicalizes the phone to E.164 (the consumer chokepoint), and calls `accrueFromOrderCompleted`. Run with `pnpm dev:worker` (dev) / `node dist/worker.js` (prod).

- **`CRM_REDIS_URL`** must point at the **same Redis kds-api uses** — the queue is a cross-app message bus (not a shared system-of-record, so Iron Law #1 holds). Optional config so the HTTP server boots without Redis; the worker asserts it at startup.
- A malformed job **throws** (BullMQ retries → dead-letters) — surfaces a contract bug rather than silently dropping an earn. A bad / empty customer phone **skips** as anonymous (not a retryable failure).
- **Failed accruals are persisted to a dead-letter table on the final attempt** (GH #467). The `failed` handler calls `deadLetterRowForFailedAccrual` (in `worker-handler.ts`, unit-tested) and INSERTs a `CrmDeadLetterJob` row only when retries are exhausted — so a terminally-failed accrual is queryable + replayable (`crm_dead_letter_jobs`), not just logged. The stored `payload` **strips the phone** (PII) but keeps `merchantId` + the rest for forensics. The DLQ write is best-effort (a failure there only logs; it never crashes the worker).
- Structured JSON logs only: the job id + accrual status, **never** the event body or phone.

## Phase status

P3 = service skeleton + read APIs + enroll. P4a = the accrual service (`domain/accrual.ts`) + the earn engine. **P4b (done) wired it**: kds-api emits `order.completed` onto the `crm-loyalty-accrual` queue after the sync tx commits ([PR4c] #346), and the standalone worker above consumes it ([PR4d]). `OrderCompletedEvent` + `EarnLine` migrated to `packages/contracts` (ADR-0025). Next: P5 redemption + nightly expiry + fraud guards; P6 customer UI + SMS + operator dashboard. **Deploy is user-gated** (artifacts STAGED, not provisioned): the crm **Dockerfile**, the `build-images.yml` matrix entry, and `compose/crm.yml` (a `crm-api` HTTP service + a separate `crm-worker` service — one image, two entrypoints, like kds-api/kds-worker) now exist and are `docker build`-verified, but nothing is deployed. Remaining go-live steps (the owner's): provision the crm host `.env` + its `postgres-crm` volume (it deploys like the other stacks now, via the `build-images.yml` SSH deploy), set the env (esp. **`CRM_REDIS_URL` = the kds stack's `REDIS_URL`** so the worker drains the same queue), seed the 6 reward rungs, then trigger `build-images.yml`. (db-crm was added to the CI migration smoke-test 2026-06-14.) Deploy crm-worker before/with the kds-api emit so no jobs strand.
