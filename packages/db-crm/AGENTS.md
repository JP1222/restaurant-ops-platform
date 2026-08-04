# Database Agents (CRM / Loyalty)

`packages/db-crm` owns the Prisma schema, migration history, and database client for the **loyalty / CRM** domain (customers, loyalty accounts, the append-only points ledger, the reward catalog, redemptions, referrals). It is a sibling of `packages/db-kds` / `packages/db-inventory`, not a replacement: per Iron Law 1 each app owns its own Postgres database, and the loyalty domain picks its own here (`CRM_DATABASE_URL`). See [ADR-0021](../../docs/decisions/0021-loyalty-crm-domain.md).

The generated Prisma client is emitted to a package-local path (`generated/client`, gitignored) and re-exported from `src/index.ts`, so it never collides with db-kds / db-inventory clients in the shared `node_modules/@prisma/client` location.

Use these checks when relevant:

- `pnpm --filter @rop/db-crm generate`
- `pnpm --filter @rop/db-crm build`
- `pnpm --filter @rop/db-crm migrate`        # dev migration
- `pnpm --filter @rop/db-crm migrate:deploy`  # apply baseline in CI/prod

Do:

- **Keep `CrmPointsLedger` append-only** ([ADR-0022](../../docs/decisions/0022-loyalty-ledger-and-accrual.md)). Rows are immutable signed-delta events; the ONLY permitted mutation is a `status` flip `PENDING -> AVAILABLE | REVERSED`. A refund is a new `REVERSE` row (`reversesLedgerId -> EARN`), never an edit. Balance is a projection (`SUM(points WHERE status=AVAILABLE)`), cached on `CrmLoyaltyAccount.balancePoints`.
- **Rely on the `@@unique([source, sourceId, type])` constraint for idempotency.** POS webhooks + BullMQ are at-least-once; a replayed accrual must INSERT-conflict into a no-op. Do not remove or weaken it.
- **Treat phone (`CrmCustomer.phoneE164`) as the single customer identity** across the suite ([ADR-0024](../../docs/decisions/0024-membership-crm-customer-identity.md)). E.164 normalization is crm-api's job before write.
- Key ledger rows by the suite store identifier (`merchantId`, conceptually `Location` — [ADR-0019](../../docs/decisions/0019-decouple-store-identity-from-clover.md)); the customer is brand-global.
- **Carry `tenantId` on every tenant-owned row** — the denormalized multi-tenant scope key ([ADR-0818](../../docs/decisions/0818-multi-tenant-platform-architecture.md)). A bare nullable string today (crm does **not** own the `Tenant` table — it lives in db-kds, Iron Law 1, so no FK), backfilled to `tenant-default`. It is the future RLS predicate and the brand-global → **tenant-global** wall: the `@@unique([tenantId, phoneE164])` / slug / code rework (so two restaurant businesses never share a customer) lands in a **separate, post-backfill** migration, never in the same step as the column add. Nothing reads it yet (Phase 1 is pure plumbing, zero behavior change).
- Keep migrations explicit and reviewable; document compatibility + rollback when changing existing shapes.
- The reward catalog (`CrmReward`) is the owner-editable source of the redemption ladder; the design default (6 rungs) is seeded by crm-api in Phase 3, not here.

Do not:

- Cross-import this client into another app's service (Iron Law 1, eslint-enforced via `dbCrmPattern`). **Only `apps/crm-api` consumes it**; every other app calls crm-api over HTTP.
- Store gift-card / stored-value balances here. Points carry **no cash value** and must never convert to gift-card value ([ADR-0023](../../docs/decisions/0023-loyalty-points-legal-posture.md)); gift-card stored value lives in a separate, rented system (Clover / Factor4).
- `UPDATE` or `DELETE` ledger rows to "fix" a balance — append a correcting `ADJUST` / `REVERSE` row instead.
- Add columns for client-only presentation state.
