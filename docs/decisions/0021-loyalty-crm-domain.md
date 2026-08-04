# ADR-0021: Introduce packages/db-crm + apps/crm-api (loyalty/CRM domain)

- **Status**: Proposed
- **Date**: 2026-05-30
- **Deciders**: @example-org

## Context

Example Kitchen is building its own loyalty/points + CRM program rather than using
Clover's native loyalty (which silos per `merchantId` and cannot span a
heterogeneous, multi-location future — see
[`pos-integration-loyalty-giftcard-landscape`] research and
[loyalty-system-design.md](../design/loyalty/loyalty-system-design.md)). The
program must be **POS-agnostic** (accrue from the canonical `NormalizedOrder`,
never a Clover-specific shape) and **multi-location** (one balance per customer,
keyed by phone, across all the owner's stores).

This is a new domain with its own entities (`CrmCustomer`,
`CrmLoyaltyAccount`, `CrmPointsLedger`, `CrmReward`, `CrmRewardRedemption`,
`CrmReferral`). Two structural questions:

1. **Where does the data live?** Iron Law #1 (DB boundary) requires each app to
   own its database behind its own Prisma package. The points ledger is
   append-only and high-write (every paid order across every store writes a
   row) with an access pattern distinct from KDS tickets or inventory.
2. **Where does accrual run?** The "order completed" signal originates in
   `kds-api` (it owns Clover sync). The naive option is to write loyalty rows
   from inside `kds-api`'s order-sync transaction.

## Decision

Create a **new database package `packages/db-crm`** and a **new service
`apps/crm-api`**, mirroring the existing `db-inventory` / `inventory-api` pair.

1. `packages/db-crm` clones `packages/db-inventory`'s pattern exactly: `PrismaPg`
   adapter, `generated/client` output, arm64 `binaryTargets`, a plain-object
   `prisma.config.ts` reading `process.env.CRM_DATABASE_URL`, a
   `createPrismaClient(connectionString)` factory, `package.json`
   `files: [dist, prisma, prisma.config.ts, generated]`, and
   `generate`/`migrate`/`migrate:deploy`/`seed` scripts. All models are
   `Crm`-prefixed and `@@map` to snake_case.
2. `apps/crm-api` clones `apps/inventory-api`'s Fastify structure (`app.ts`
   factory route registration, `config.ts`, `lib/` service factory, `domain/`,
   `routes/`). It owns: the accrual BullMQ worker, customer read APIs
   (enroll/lookup by phone, balance, history, reward catalog), redemption
   issue/void, and the nightly expiry job.
3. **Accrual lives in crm-api, not kds-api.** Justification: separation of
   concerns; independent scaling/deploy of a high-write append-only ledger;
   Iron Law #1 (crm-api owns its own DB, so writing loyalty rows from a kds-api
   transaction would cross the DB boundary); and keeping kds-api a pure
   POS-sync/KDS service. The cross-service signal is an event, not a shared
   transaction (see [ADR-0022](0022-loyalty-ledger-and-accrual.md)).
4. **Physical DB now, like ADR-0015's precedent.** `db-crm` gets its own
   Postgres from the start (the ledger's write pattern justifies it), rather
   than co-locating in postgres-kds and splitting later.
5. **Boundary enforcement.** Add a `dbCrmPattern` rule to `eslint.boundaries.mjs`
   + the default restriction in `eslint.config.mjs`: `@rop/db-crm` is
   importable only from `apps/crm-api/**` (and `packages/db-crm/**` itself).
   Every other app calls crm-api over HTTP — backoffice and crew never import
   the client. This makes Iron Law #1 machine-enforced for the new package,
   per [ADR-0012](0012-architecture-as-guardrails.md).
6. **Doc-drift registration.** Add the six `Crm*` models to
   `scripts/check-doc-drift.sh`'s known-models list and an `apps/crm-api` /
   `packages/db-crm` row to `ARCHITECTURE.md` §2; add their `AGENTS.md` files to
   the AGENTS coverage check.

## Consequences

- A fifth app and a fourth db package join the monorepo. Deployment adds a
  Dokploy `crm-api` project + Postgres (mirror the `db-inventory` stack setup,
  see [[dokploy-inventory-stack]]).
- The loyalty domain is fully POS-agnostic and reusable across heterogeneous
  future stores — the entire point of building rather than buying.
- crm-api becomes a new on-call surface (a solo-ops cost — see
  [[build-vs-buy-philosophy]] caveats). Accrual is fire-and-forget from kds-api
  with a dead-letter fallback so a crm-api outage never stalls the kitchen
  ([ADR-0022](0022-loyalty-ledger-and-accrual.md)).
- This is **not** a second writer to a kds-db business table, so it does **not**
  trip [ADR-0011](0011-ai-tables-bounded-exception.md)'s hard-stop — crm-api
  owns its own database.

## Alternatives considered

- **Accrue inside kds-api** (write loyalty rows from the order-sync
  transaction). Rejected: crosses the DB boundary, couples loyalty availability
  to order sync, and bloats kds-api beyond its POS-sync charter.
- **Co-locate CRM tables in postgres-kds, split later** (the ADR-0015 shape).
  Rejected here: the append-only ledger's high-write pattern and independent
  scaling profile justify a separate Postgres from day one; the package
  boundary alone wouldn't isolate the write load.
- **Buy a mid-market multi-POS loyalty SaaS** (Spendgo-class, ~$3-5k/yr).
  The documented fallback if eng bandwidth tightens; rejected for now because
  the suite already runs its own software and owning the data/IP avoids
  compounding SaaS lock-in ([[build-vs-buy-philosophy]]).

## Future work (out of scope here)

- The append-only ledger semantics, idempotency, the accrual event contract,
  and the `NormalizedOrder` monetary-block change →
  [ADR-0022](0022-loyalty-ledger-and-accrual.md).
- The no-cash-value legal posture and the gift-card firewall →
  [ADR-0023](0023-loyalty-points-legal-posture.md).
- Multi-location grouping/rollup above `merchantId` (the Location layer) is a
  separate, broader effort; db-crm is keyed by phone + `merchantId`/`locationId`
  from the start so it is ready for it.
