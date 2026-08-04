# ADR-0017: DeepSeek replaces Codex for the AI assistant

- **Status**: Accepted
- **Date**: 2026-05-27
- **Deciders**: @example-org
- **Supersedes the Codex / ChatGPT-subscription path in**: [ADR-0011](0011-ai-tables-bounded-exception.md) (the AI tables stay; the auth profile table is gone)

## Context

Phase 7 shipped the floating AI assistant with an OpenAI Codex provider driven by an OAuth flow against `chatgpt.com/backend-api/codex`. The flow stored encrypted access + refresh tokens in `ai_auth_profiles` (KDS DB), refreshed them proactively, and routed the assistant through ChatGPT-subscription pricing.

Two problems accumulated:

1. **Operational complexity vs single-merchant scale.** ~400 LOC of OAuth machinery — PKCE pair generation, JWT decoding, state store, refresh-skew logic in `resolveAuth`, encrypted token CRUD, four BFF endpoints (`/api/ai/oauth/{start,complete,profiles,test}`), three settings components (`ai-oauth-section`, `oauth-add-dialog`, `oauth-profile-row`), seven test files, an entire Playwright wizard spec — for what is a single-tenant, single-operator key. The complexity exists because Codex doesn't offer a static API key for ChatGPT subscriptions; OAuth is the only path.
2. **Cost / capability fit.** DeepSeek's v4 generation matches our analytics-assistant workload (typed tool calls, mid-thousand-token answers) at materially lower per-token cost than the GPT-5.5 family Codex routes us to, and offers a native thinking-mode toggle for deeper questions.

## Decision

1. The AI provider is now **DeepSeek**, via `@ai-sdk/deepseek` (the official Vercel AI SDK provider for `api.deepseek.com`).
2. Auth is a single environment variable: **`DEEPSEEK_API_KEY`**. No DB profile, no refresh, no file fallback.
3. Default model is **`deepseek-v4-pro`**; the alternative is `deepseek-v4-flash`. Both run the same Chat Completions endpoint at `api.deepseek.com`. The legacy `deepseek-chat` / `deepseek-reasoner` aliases (deprecated by DeepSeek on 2026-07-24) are NOT in our enum.
4. Reasoning is a runtime toggle, not a separate model id. When `ai.thinking_mode` (boolean AppSetting, default false) is true, the chat route attaches `providerOptions.deepseek.thinking.type: "enabled"` to `streamText`. When false, no providerOptions block is sent. (DeepSeek also supports `"adaptive"` and `reasoningEffort` levels; these are deferred to a follow-up that promotes `ai.thinking_mode` from boolean to enum.)
5. The chat route uses `provider.chat(modelId)`. DeepSeek does NOT implement the OpenAI Responses API, so `.responses()` would 404 — this is a deliberate departure from the Codex implementation that used `provider.responses()`.
6. Model id, thinking mode, max output tokens, and kill switch read from `lib/settings` (ADR-0016 AppSetting registry) rather than env vars. The DeepSeek **API key** stays in env per ADR-0016 §4 (secrets-not-settings rule).
7. The `ai_auth_profiles` table is dropped in this PR. `AiConversation` and `AiMessage` remain — conversation history is provider-independent.

## What's deleted

- `lib/ai/codex-provider.ts`, `lib/ai/codex-auth.ts`
- `lib/ai/oauth/` (exchange, jwt-decode, pkce, profile, state-store) — 5 modules
- `app/api/ai/oauth/` (start, complete, profiles, profiles/[id], test) — 5 route handlers
- `components/settings/{ai-oauth-section,oauth-add-dialog,oauth-profile-row}.tsx`
- `components/ai/not-configured-banner.tsx` (the "Sign in with ChatGPT" CTA)
- `hooks/use-ai-oauth.ts`
- `lib/crypto/encryption.ts` (its only consumer was `oauth/profile.ts`)
- `e2e/ai-oauth-wizard.spec.ts`
- 7 OAuth/Codex vitest files under `tests/`
- Prisma model `AiAuthProfile` + table `ai_auth_profiles` (migration `20260527_drop_ai_auth_profiles`)
- Dependencies `@ai-sdk/openai`, `@ai-sdk/anthropic` (neither has a remaining consumer after the swap)

Net change is ~600 LOC removed, ~120 LOC added. The chat route itself loses ~30 LOC; the savings come from the OAuth machinery disappearing.

> **Migration history note (the `ai_auth_profiles` create/drop pair).** The original
> create-table migration `packages/db-kds/prisma/migrations/20260519_ai_auth_profiles/migration.sql`
> still carries `"provider" TEXT NOT NULL DEFAULT 'openai-codex'` — a Codex-era default
> for a column on a table this ADR deletes. It is **superseded by** `20260527_drop_ai_auth_profiles`,
> which drops the index pair and the table. Both migrations are intentionally retained as
> separate, immutable history entries: production DBs that ran `20260519` before this PR must
> see the matching `DROP`, so `prisma migrate deploy` reaches the same end state on every
> environment. Do **not** collapse or hand-edit the pair (an already-applied migration is
> immutable — see `packages/db-kds/AGENTS.md`). On a brand-new clean DB the two run back-to-back
> (create then drop) — harmless, just transient. The `'openai-codex'` default never reaches a
> live schema because the table no longer exists after `20260527`.

## Consequences

- **Provisioning a new deploy is now a single env var.** Set `DEEPSEEK_API_KEY` in Dokploy compose secrets; restart `backoffice-web`. No login wizard, no per-operator setup.
- **The "AI is not configured" UX shifts.** The old banner watched `/api/ai/oauth/profiles` for a profile row. There's no equivalent client-side check now — if the env var is missing, the chat route returns 503 `auth_not_configured` and the existing error path renders that. If the operator needs a more proactive banner, it can be added in PR-C alongside `/settings/system`.
- **Per-operator keys are no longer supported.** If the team later needs multi-tenant or BYO-key flows, AppSetting can grow a per-account secret category, but secret storage should NOT be co-located with tunable config (ADR-0016 §4) — that would need its own table and ADR.
- **The Iron-Law 1/5 carve-out for `lib/ai/**` shrinks in surface but stays.** `AiConversation` / `AiMessage` are still backoffice-written; `db.ts` still imports `@rop/db-kds`. ADR-0011 is updated, not retired.

## Alternatives considered

- **Keep both providers behind a selector.** Rejected — adds the provider-abstraction layer cost (a `Provider` interface, env-driven factory, two parallel test suites) for a single-merchant tool where one provider at a time is sufficient. If a future operator wants Anthropic / OpenAI again, this ADR can be superseded; the chat route is the only seam.
- **Switch to a self-hosted DeepSeek inference endpoint.** Rejected for now — the single-merchant cost profile (low daily tokens) doesn't justify standing up GPU infra; Dokploy doesn't have GPU nodes. Revisit if usage grows materially.
- **Use OpenAI's Platform API (static keys) instead of Codex's OAuth.** Rejected — same OpenAI tier pricing as the GPT family but loses the existing $20/mo ChatGPT-subscription billing path we'd already integrated against, and doesn't address the underlying "OAuth machinery is overkill" problem since `OPENAI_API_KEY` was already a supported fallback that nobody used.
- **Defer the OAuth deletion to a follow-up PR.** Rejected — leaving dead code in `lib/ai/` violates AGENTS.md's "no half-finished implementations" rule and creates ambiguity about which provider is real.
