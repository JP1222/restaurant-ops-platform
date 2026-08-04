# ADR-0004: Static Clover token from DB, OAuth optional

- **Status**: Accepted
- **Date**: 2026-05-16 (production rollout)
- **Deciders**: @example-org

> **Update (2026-06-18, multi-location):** The "assumes one active merchant" / "multi-merchant is a future migration" framing below is now **in progress, not hypothetical** — a POS-agnostic `Location` registry + per-merchant scoping landed under [ADR-0018](./0018-multi-location-architecture.md) and [ADR-0019](./0019-decouple-store-identity-from-clover.md), and a second store (Square) is onboarded ([docs/multi-location.md](../multi-location.md), [docs/square-onboarding.md](../square-onboarding.md)). The static-token-from-DB decision itself still holds — per-store tokens now live AES-GCM-encrypted in `clover_merchants` / `pos_accounts`. The body is preserved for the historical record; the dead `infrastructure/dokploy/FUTURE_IMPROVEMENTS.md` §7 pointers for the analytics token-sync gap are superseded by the analytics **sync-target** plan in [docs/multi-location.md](../multi-location.md) ("Deferred / remaining work").

## Context

Clover provides two integration patterns for an app to call merchant APIs:

1. **Static merchant token** — Operator generates an access token from the Clover dashboard ("Setup → API Tokens" or via merchant app installation in test mode) and pastes it into our app. The token is long-lived (typically months) but can be revoked or rotated by the operator at any moment. No OAuth dance.

2. **OAuth merchant-authorized install** — Our app registers as a Clover marketplace app, the operator installs it via Clover's flow, Clover redirects to our `oauth/callback` with a code, we exchange for `access_token` + `refresh_token`. Tokens rotate; refresh handling is required.

For a **single-merchant deployment** owned by the same person operating the restaurant, both work but have different ergonomics:

- Static token: 30 seconds in the Clover dashboard, paste it, done. Recovery is the same operation.
- OAuth: register a marketplace app (~hours), maintain redirect URLs, handle refresh-token rotation, handle webhook signature verification through the app context.

Pre-Phase 0, the Intelligence repo used **env-only static tokens** (`.env` → docker compose → container). Token rotation required: SSH, edit `.env`, `docker compose up -d --force-recreate`. The KDS repo used a similar pattern but had started persisting tokens in a `clover_merchants` table for future multi-merchant readiness.

Then came the operational pain points:

- **Token rotation should not require a redeploy.** If the operator wants to revoke and re-issue at 6pm Friday, paying a 30-second container restart hit (during dinner rush) is unacceptable.
- **The two services (kds-api + analytics-api) need the same token**, but they restart independently — if env is the source, we can update one and not the other and not notice until ingestion goes 401.
- **OAuth was overkill for the deployment scope.** No marketplace listing needed; we control both the merchant and the app.

## Decision

**Static merchant token is the primary steady-state Clover integration path.** The active merchant's `accessToken` lives in the `clover_merchants` table in `postgres-kds`, set via the `/admin/integrations/clover` page in `backoffice-web` (admin paste UX). `kds-api` reads from this DB row at runtime, refreshes its cached value on each Clover call.

`CLOVER_MERCHANT_ID` and `CLOVER_TOKEN` env vars remain **optional bootstrap/fallback** for first install or recovery. If the DB row exists, the env values are ignored (the DB wins). The README and `apps/kds-api/AGENTS.md` document this priority.

**OAuth remains in the code but is opt-in.** The `/api/clover/install` and `/api/clover/oauth/callback` routes are wired; `CLOVER_APP_ID` + `CLOVER_APP_SECRET` + `CLOVER_WEBHOOK_AUTH_CODE` env vars enable them. For deployments that need merchant-authorized installs (e.g. a future marketplace listing), OAuth is one config away.

## Consequences

**Makes easy:**

- **Token rotation is a 30-second UI operation.** Operator opens `backoffice.example.com/admin/integrations`, pastes the new token, clicks Save. `kds-api`'s next Clover call uses the new value (cache TTL is short). No redeploy.
- **Setup is light.** A new deployment doesn't need a Clover marketplace registration. The README's Quick Start works end-to-end with just `CLOVER_MERCHANT_ID` and `CLOVER_TOKEN` set to bootstrap values.
- **Recovery is also a UI operation.** If the token gets revoked or invalidated, re-paste — no SSH, no env edits.

**Makes hard:**

- **`analytics-api` doesn't share the DB.** Iron Law #1 prohibits it from reading `postgres-kds`. So `analytics-api` reads `CLOVER_TOKEN` from its **own Dokploy compose env** — set once at deploy. A token rotation in `backoffice` (which writes to kds DB) leaves `analytics-api` stuck on the old token until manually updated.
  - **Symptom**: KDS board stays current (kds-api uses fresh DB token), but analytics dashboards stop updating (analytics-api returns 401 from Clover).
  - **Current mitigation**: [`scripts/check-business-health.sh`](../../scripts/check-business-health.sh) cron alerts on Clover 401s.
  - **Long-term fix**: Dokploy-aware auto-sync sketched in `infrastructure/dokploy/FUTURE_IMPROVEMENTS.md` §7 (file removed with Dokploy, 2026-06-04) — pending implementation.
  - **Operationally documented** in [`OPERATIONS.md` §6.3](../../OPERATIONS.md#63-clover-401--silent-integration-failure).
- **No automatic token expiry handling.** OAuth refresh-token flows would auto-rotate; static tokens don't. We rely on the operator to notice (or check-business-health.sh to alert).
- **Multi-merchant becomes a future migration.** Today the system assumes one active merchant in `clover_merchants`. If we ever onboard a second, every kds-api code path that reads `WHERE active = true` becomes a coordinated change.

**New risks:**

- Token compromise is undetectable from inside the system — Clover doesn't tell us the token was used elsewhere. The mitigation is "rotate yearly anyway, even if nothing looks wrong" (see [`OPERATIONS.md` §7.2](../../OPERATIONS.md#72-rotation-procedures)).

## Alternatives considered

- **OAuth-only.** Rejected at this scope. The setup overhead (Clover marketplace registration, OAuth redirect URLs, refresh-token rotation logic) doesn't pay back for a single-merchant deployment we control end-to-end. Would reconsider if we onboard external merchants.

- **Env-only static token (pre-Phase 0 state).** Rejected because token rotation requires redeploy. Operators rotating tokens during dinner rush should not require a restart.

- **DB token + env token, with env-as-override.** Considered. We chose DB-as-source-of-truth because operators' mental model is "paste in admin page". An env-override mode introduces a confusing "the page shows X but ingestion uses Y" failure mode.

- **Dokploy-aware token sync at write time.** Would solve the analytics-api token gap: backoffice writes token to KDS DB, *also* writes to Dokploy compose env via tRPC, redeploys analytics-api. Deferred — the sync is fiddly (Dokploy env is a multi-line string, has to be parsed/diffed/rewritten), and the failure mode is already alerted on. Concrete sketch in FUTURE_IMPROVEMENTS §7.

## Related

- [ADR-0001: pnpm monorepo with four apps](./0001-pnpm-monorepo-with-four-apps.md) — context for why kds-api and analytics-api are separate services.
- [ADR-0002: Five Iron Laws](./0002-five-iron-laws.md) — Iron Law #1 prohibits analytics-api from reading KDS DB, which is the load-bearing cause of the token-sync gap.
- [`OPERATIONS.md` §6.3](../../OPERATIONS.md#63-clover-401--silent-integration-failure) — operator-facing runbook for the symptom.
- `infrastructure/dokploy/FUTURE_IMPROVEMENTS.md` §7 (file removed with Dokploy, 2026-06-04) — proposed long-term fix.
