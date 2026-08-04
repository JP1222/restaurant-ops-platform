# ADR-0011: AI assistant tables are a bounded exception to the DB boundary

- **Status**: Accepted
- **Date**: 2026-05-24
- **Updated**: 2026-05-27 — `AiAuthProfile` table removed by [ADR-0017](0017-deepseek-replaces-codex.md) (DeepSeek API key replaced the OAuth flow). `AiConversation` and `AiMessage` remain under this carve-out.
- **Deciders**: @example-org

## Context

The Backoffice AI assistant (Phase 7) persists conversations and messages in two tables — `AiConversation`, `AiMessage` — defined in `packages/db-kds/prisma/schema.prisma` (the KDS database's schema). `apps/backoffice-web/lib/ai/db.ts` writes to them directly via `createPrismaClient()` from `@rop/db-kds`.

(Historical note: a third table `AiAuthProfile` once held encrypted OAuth tokens for the Codex/ChatGPT-subscription path. It was dropped in 2026-05-27 when ADR-0017 swapped to a single DeepSeek API key. The carve-out still applies because the remaining two tables are governed by the same reasoning.)

Read literally, this violates two Iron Laws:

- **Law 1 (database boundary)** — "Backoffice reads from KDS DB only because it reuses the auth tables — never business tables." The AI tables are business tables.
- **Law 5 (reads are not writes)** — "Backoffice never writes to [the KDS DB]." It writes AI rows directly.

The violation shipped silently because the laws lived only in prose (see ADR-0012, which fixes that). But the *dangers* the laws guard against do not actually arise here, and an audit confirmed why:

- The AI tables have **zero foreign keys** into KDS business or auth tables. `userId` is a plain string, not a relation to `WebAdminAccount`. The only FK is `AiMessage.conversationId → AiConversation` (internal).
- KDS services **never read** the AI tables; backoffice is the **single writer**. There is no two-master state machine and no cross-app migration coordination — the exact failure modes Laws 1 and 5 exist to prevent.

So this is a violation of the *letter* of the laws, not their *spirit*. The deployment is single-merchant, dev/staging-grade, on one VM; standing up a separate `postgres-backoffice` for three low-traffic tables would add an ops surface and a second connection pool for no risk reduction.

## Decision

Treat the `ai_*` tables as a **bounded, documented exception**, not drift:

1. The `ai_conversations` / `ai_messages` tables are **backoffice-owned business data**, co-located in `postgres-kds` solely to reuse the existing auth connection pool (`globalThis.__ropBackofficeAuth.prisma`).
2. Backoffice may import `@rop/db-kds` **only** under `lib/ai/**` (this exception). This is enforced mechanically by an ESLint `no-restricted-imports` carve-out in `eslint.config.mjs` (see ADR-0012) — a `db-kds` import anywhere else in `backoffice-web` fails the build. **History note**: a sibling `lib/auth/**` carve-out existed until ADR-0015 split the auth tables into `@rop/db-auth`; that carve-out has since been retired.
3. Backoffice **must never** read or write any KDS *business* table (orders, tickets, devices, provider config). If KDS business data is needed, call `kds-api`.
4. Any proposal to add a *second* writer to a KDS business table is a hard stop and requires its own ADR.

## Consequences

- The exception is now explicit, scoped, and lint-enforced — future agents see the carve-out and its reason rather than copying "backoffice writes the KDS DB" as a general pattern.
- `ARCHITECTURE.md` §2 gains an "AI assistant" surface entry so the feature is no longer invisible in the architecture map.
- If the suite ever goes multi-merchant or the AI tables grow hot, revisit by promoting them to a backoffice-owned database (the migration is clean precisely because there are no cross-table FKs).

## Alternatives considered

- **Move the tables to a separate backoffice database.** Cleanest letter-of-the-law fix, but adds a Prisma client, a second pool, Dokploy DB provisioning, env wiring, and a data migration — disproportionate at single-merchant scale. Deferred, not rejected forever.
- **Separate Postgres schema namespace (Prisma `multiSchema`) in the same DB.** Makes ownership explicit at the DB level but is still one physical database, so it satisfies Law 1 no better than co-location while adding migration complexity.
- **Do nothing / leave it undocumented.** Rejected — the silent violation is the precise failure this and ADR-0012 exist to end.
