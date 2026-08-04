# ADR-0020: Adopt Infisical as the runtime secret source

- **Status:** Accepted (phased rollout in progress)
- **Date:** 2026-05-30
- **Supersedes:** parts of the env-based secret handling described in `apps/backoffice-web/AGENTS.md` rule 16 (the bootstrap set is unchanged; see below)
- **Related:** ADR-0016 (`app_setting` table), ADR-0017/0018 (secret category, multi-location scope), `docs/plan/infisical-migration.md` (the full migration blueprint)

## Context

Runtime/infrastructure secrets live in **four** uncoordinated homes today: `.env` files, Dokploy per-service env (`compose-dokploy/*.yml`), GitHub Actions secrets, and ad-hoc 1Password entries. The same secret (`SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`, the `ANALYTICS_ADMIN_TOKEN`/`ADMIN_TOKEN` pair, `INVENTORY_INTERNAL_TOKEN`) is **hand-duplicated** across multiple compose files and must be kept byte-identical or services 401/503 each other. There is no audit trail and no single rotate-once surface.

This is distinct from the `app_setting` encrypted store (ADR-0016/0017/0018), which is the **operator-rotatable, hot-reloadable, UI-editable** store for things like `ai.deepseek_api_key`. That store is **not** replaced here — the two are complementary layers.

## Decision

Adopt a single **Infisical** project (`restaurant-ops-platform`, env `dev`/`staging`/`prod`) as the source of truth for runtime/bootstrap-adjacent secrets, injected into each process at startup via `infisical run -- <cmd>` (no `.env` written to disk; app code keeps reading `process.env` through the existing zod env schemas — `lib/env.ts` / `src/config.ts` are unchanged).

Two-layer secret model, with a human vault completing the picture:

| Layer | Store | Read by | Examples |
|---|---|---|---|
| Runtime app secrets | **Infisical** (`dev`/`prod`) | machines via `infisical run` | `CLOVER_*`, `INVENTORY_INTERNAL_TOKEN`, `CREW_*`, `ANALYTICS_ADMIN_TOKEN` |
| Operator-rotatable, hot-reload | **`app_setting`** (AES-GCM) | backoffice at runtime | `ai.deepseek_api_key` |
| Bootstrap / break-glass / roots | **env (Dokploy) + 1Password** | humans / pre-Infisical boot | `DATABASE_URL`, `APP_SETTING_ENCRYPTION_KEY`, `SESSION_SECRET`, the Infisical credential itself |

### The irreducible "secret zero"
Infisical removes app secrets from Dokploy but cannot remove the **one** credential needed to talk to Infisical. That credential (a read-only, env-scoped Infisical service token or machine identity) lives in Dokploy per-service env for prod, is backed up in **1Password**, and is interactive-login for local dev. Net change: **N scattered secrets → 1 scoped, revocable, audited credential per consumer.** Not zero — fewer and better.

### What deliberately stays OUT of Infisical
- **Bootstrap set** (genuinely needed before/independent of an Infisical fetch): the database URLs (`DATABASE_URL`, `INVENTORY_DATABASE_URL`) and `POSTGRES_PASSWORD`. Prisma migrate sidecars run before the app and must not depend on an Infisical fetch, so the DB URLs stay in env. `SESSION_SECRET` and `KDS_INTERNAL_ADMIN_TOKEN` are the *debatable* bootstrap lines slated to migrate to Infisical last (see Status). **The AES-GCM master keys (`AI_TOKEN_ENCRYPTION_KEY`, `APP_SETTING_ENCRYPTION_KEY`) are Layer-1 Infisical secrets, NOT bootstrap — corrected 2026-06-18, see the amendment below.**
- **CI/deploy control-plane** (`DOKPLOY_WEBHOOK_*`, `DOKPLOY_API_KEY`) — must not depend on a successful Infisical fetch (no circular deploy bootstrap). Stays GitHub Actions secrets / 1Password.
- **The self-hosted/Cloud Infisical instance's own encryption key** — losing it makes every stored secret unrecoverable; backed up out-of-band in 1Password.
- **`app_setting`-managed keys** (`ai.deepseek_api_key`) — already in the encrypted DB store; not re-fragmented into Infisical. *(Exception: the invoice-scan vision key. Its resolver prefers the `ai.vision_api_key` DB row but falls back to a `GEMINI_API_KEY` env var, and prod runs on that env var injected from Infisical — so `GEMINI_API_KEY` is a Layer-1 member, not Layer 2. See OPERATIONS §7.1.)*

## How it's wired (resilient, reversible)

`scripts/with-infisical.sh` is a container entrypoint wrapper: **if** an Infisical credential is present it runs `infisical run -- <cmd>`; **otherwise it runs the command unchanged.** A Dockerfile using it with no Infisical env set is equivalent to today's behavior — so the rollout is per-service and instantly reversible by removing the env vars.

- **Prod (Dokploy):** entrypoint = `with-infisical`; secret-zero (`INFISICAL_TOKEN` or machine-identity client id/secret + `INFISICAL_PROJECT_ID` + `INFISICAL_API_URL` + `INFISICAL_SECRET_ENV=prod`) in Dokploy env.
- **Local dev:** `infisical login` (Keychain) + `pnpm dev:infisical`; `pnpm dev` / `dev:raw` remain as the no-Infisical escape hatch.
- **AI agents (Codex + Claude Code):** the Infisical MCP server (`@infisical/mcp`) with a read-only, `dev`-only machine identity (`.mcp.json.infisical.example`), or `infisical run -- pnpm test`.
- **CI:** OIDC machine identity, added only when a job actually needs a real secret (today CI runs on a dummy `DATABASE_URL`).

## Consequences

- One rotate-once surface for the cross-service shared secrets; the byte-identical compose duplication goes away.
- One new dependency (Infisical reachability) at container start for migrated services — mitigated by the resilient wrapper and by keeping the boot-critical bootstrap set in env.
- Read-only/dev-only machine identities fence agent and CI access away from prod (RBAC is the guardrail, not the tool list).

## Status / rollout

Phased per `docs/plan/infisical-migration.md`: structure + dev/prod populated → reference service (backoffice-web) wired → validate in prod → roll out remaining services → migrate the debatable bootstrap lines (`SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`) last.

## Amendment — 2026-06-18: the AES-GCM master keys are Layer-1 Infisical, not bootstrap

The original "What deliberately stays OUT of Infisical" bullet placed `AI_TOKEN_ENCRYPTION_KEY` and `APP_SETTING_ENCRYPTION_KEY` in the bootstrap set, justified by "Prisma migrate sidecars run before the app and must not depend on an Infisical fetch." **That justification does not hold for these keys.** The migrate sidecars run only `prisma migrate deploy` (they receive `DATABASE_URL` and nothing else) and never read an encryption key; `getKey()` runs at application runtime, *after* `with-infisical` has already injected the environment. The migration files themselves document this (they note migrations have no access to the keys).

The keys are therefore **Layer-1 Infisical secrets** — the live posture OPERATIONS.md §7.1 already describes — with a 1Password break-glass copy that satisfies the only real constraint here: a key protecting an at-rest store should not be recoverable *only* from the manager/store it protects.

This was forced into the open by the 2026-06-18 KDS outage: `AI_TOKEN_ENCRYPTION_KEY` had never been placed in any source the kds stack reads at runtime, and a lazy validation (first encrypt) crash-looped kds-api + kds-worker for ~13h. The fix wired the key into `compose/kds.yml` as a passthrough, added an eager `assertAiTokenEncryptionKey()` boot gate, and reconciled the docs. See `docs/audits/2026-06-18-secret-management-audit.md`.

**OPERATIONS.md §7.1 is canonical for secret placement; this ADR's bootstrap-set bullet is corrected to match.** `SESSION_SECRET` and `KDS_INTERNAL_ADMIN_TOKEN` remain the deliberately-deferred bootstrap lines.
