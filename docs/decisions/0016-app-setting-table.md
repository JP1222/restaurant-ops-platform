# ADR-0016: AppSetting table extends the AI bounded exception

- **Status**: Accepted
- **Date**: 2026-05-27
- **Deciders**: @example-org

> **Update (2026-06-18, multi-location):** The "single-merchant" framing below (Context, and the "if single-merchant assumption ever breaks" consequence) is amended by [ADR-0018](./0018-multi-location-architecture.md): multi-location is now live and `app_setting.merchantId` is the **multi-location scope id** — `lib/settings/db.ts` already routes brand-tier keys to `BRAND_SCOPE_ID` and location-tier keys to a real `Location.id` (this is multi-*location*, not the multi-*tenant* model this ADR hypothesized). Whether more per-store tunables (timezone, POS thresholds) should live in `app_setting` under a `Location.id` scope vs. on the `Location` row itself (operating hours already moved there, PR #697) is **open** — see [docs/multi-location.md](../multi-location.md). The table shape and access-layer decision still hold.

## Context

Backoffice needs a runtime-editable config store so an operator can change AI defaults (model id, thinking mode, max tokens, kill switch) and — soon — Clover and other system parameters without redeploying the container. Env vars are immutable at runtime; restarting `backoffice-web` every time a flag flips is unacceptable for an owner-facing tool.

The natural fit is a single key/value table co-located with the other backoffice-owned data in `postgres-kds` (the same physical database that hosts `ai_conversations`, `ai_messages`, `ai_auth_profiles`, and the `web_admin_accounts` / `web_authn_credentials` tables from the auth carve-out).

Read literally, this is the same Iron Law 1 / 5 situation ADR-0011 already addressed: backoffice writing rows in the KDS database. But every reason the AI tables qualified as a bounded exception applies here too:

- **No foreign keys** to KDS business or auth tables. `app_setting` has only `key` (text PK), `value` (text), `category` (text), `updatedAt`, `updatedBy` (audit only, no FK).
- **Single writer**: only `backoffice-web/app/api/settings/route.ts` writes to this table. KDS services never read it.
- **Single physical database for single-merchant deployment**: standing up a third Postgres (`postgres-backoffice`) for one low-traffic table is disproportionate to the risk.

The shape — one row per setting, value JSON-encoded as text — is intentionally minimal:

- **Why text, not JSONB**: zod schemas in `packages/contracts/src/settings.ts` already validate every read and write, so JSONB's GIN indexing and operator pushdown buy nothing for the access pattern (point lookups by key). Text JSON keeps migration noise low.
- **Why one row per setting, not one wide row**: adding a new key never requires a migration. The schema cost of every new tunable falls to zero.

## Decision

1. The `app_setting` table is **backoffice-owned business data**, co-located in `postgres-kds` for the same operational reasons ADR-0011 cited for the AI tables.
2. The ESLint `no-restricted-imports` carve-out for `@rop/db-kds` is extended from `lib/ai/**` only to `lib/ai/**` **and** `lib/settings/**`. A `db-kds` import anywhere else in `backoffice-web` still fails the build.
3. The runtime contract is the registry in `packages/contracts/src/settings.ts`. Every key has a zod schema, a default, an optional env fallback, and a category. The reader (`lib/settings/index.ts`) resolves in order DB → env → default, surfacing the actual source in the API response so the UI can show "configured by you" vs "default" vs "deploy-pinned".
4. Secrets (DeepSeek API key, etc.) **stay in env**. AppSetting is for tunable behavior, not credentials. Mixing the two invites accidental exposure via the BFF response payload.
5. Any future category — Clover thresholds, reporting timezone, operating hours — adds entries to the same registry. No new tables.

## Consequences

- The exception is now wider in surface (two carve-out directories) but stays *narrower in semantics* (every key is typed by zod). A future contributor cannot add an untyped flag because the BFF rejects writes for keys absent from the registry.
- `ARCHITECTURE.md` §2 gains an `app_setting` entry alongside the AI assistant tables.
- If single-merchant assumption ever breaks (multi-tenant or per-merchant settings), `category` is augmented or a `merchant_id` column is added without rewriting the access layer.
- The reader caches nothing — every read hits Postgres. At single-merchant scale that's fine; if it becomes hot, add a per-process TTL cache in `lib/settings/index.ts` keyed on `category`.

## Alternatives considered

- **Reuse `AiAuthProfile` table with a JSON settings column.** Rejected: that table is scheduled for removal in PR-B (DeepSeek migration drops OAuth entirely). Putting settings on top of dying scaffolding adds churn.
- **Move settings to a new `postgres-backoffice` database.** Cleanest letter-of-the-law fix, but adds a Prisma client, second connection pool, Dokploy DB provisioning, env wiring, and a migration path for the existing AI tables — disproportionate at current scale. Deferred, not rejected forever.
- **JSON file in a container volume.** Rejected — doesn't survive container rebuilds, isn't backed up with Dokploy's Postgres dumps, and creates a second source of truth alongside env vars.
- **Env-only configuration.** Rejected — the user's requirement is explicitly a UI-editable settings page. Env is immutable at runtime.
- **Per-key columns on a single wide table.** Rejected — every new setting becomes a migration, which is the opposite of the goal.
