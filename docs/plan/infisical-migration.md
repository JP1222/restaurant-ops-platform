# Infisical Migration Blueprint — Example Kitchen Suite

> **Status:** historical — superseded by [OPERATIONS.md](../../OPERATIONS.md) + [docs/agent-secret-workflow.md](../agent-secret-workflow.md) (migration executed; the with-infisical model is unchanged).

> ⚠️ **Dokploy + Docker Swarm were removed after this plan was written** (see the
> Dokploy-removal ADR). Wherever this plan says "Dokploy per-service env",
> "Dokploy compose", "Dokploy UI/API", or `DOKPLOY_*` secrets, read it as: the
> per-stack **host env file** `compose/<stack>.env` (gitignored,
> template `.env.prod.example`), deployed by plain `docker compose` over SSH via
> `scripts/deploy-stack.sh`. The Infisical model itself is **unchanged** —
> secrets are still injected at container boot by the `with-infisical`
> entrypoint, and the machine-identity "secret zero" now lives in that host env
> file instead of Dokploy's env store. The CI-only secrets the plan keeps out of
> Infisical are now `ORACLE_SSH_KEY` / `ORACLE_SSH_HOST` (+ Sentry), which
> replaced the `DOKPLOY_*` set. The rest of the plan is left as originally written.

> **Status:** Proposed plan. Save at `docs/plan/infisical-migration.md`.
> **Date:** 2026-05-30
> **Scope:** Move runtime/infrastructure secrets out of scattered `.env` files, Dokploy per-service env, and GitHub Actions secrets into a single self-hosted Infisical project, leaving only an irreducible bootstrap credential in each consumer. Does **not** replace the `app_setting` operator-rotatable secret store (ADR-0016/0018) — Infisical and `app_setting` are complementary layers.

> **PLACEHOLDERS THAT MUST BE FILLED BEFORE EXECUTION.** The environment provided to this plan had blanks for the Infisical connection details. Everywhere below you see these tokens, substitute the real values from your Infisical instance:
> - `${INFISICAL_API_URL}` — your self-hosted host URL (e.g. `https://infisical.example.com` or whatever you stood up). Used as `--domain` on every CLI command and as `INFISICAL_HOST_URL` / `domain:` for MCP + GH Action. **If you are on Infisical Cloud instead, this is `https://app.infisical.com` (US) / `https://eu.infisical.com` (EU).**
> - `${INFISICAL_PROJECT_ID}` — the Project ID (the `.infisical.json` calls it `workspaceId`; same value).
> - `${INFISICAL_PROJECT_SLUG}` — the project slug (needed by the GitHub Action, which takes a slug, not the ID).
> - `${INFISICAL_ORG_ID}` — org ID (only needed when creating identities in the UI).
> - Environment slugs: this plan assumes **`dev`** and **`prod`**. If you created `staging`, add it everywhere `prod` appears. **Slugs are case-sensitive** — match them exactly.
> - Machine-identity client IDs/secrets are **not yet generated**. They are referenced only by env-var name: `ROP_PROD_CLIENT_ID` / `ROP_PROD_CLIENT_SECRET` (identity `rop-prod`), `ROP_DEV_AGENT_CLIENT_ID` / `ROP_DEV_AGENT_CLIENT_SECRET` (identity `rop-dev-agent`), and `rop-ci` (OIDC — no stored secret).

---

## 1. Context & decision recap

### What we have today
Secrets in this repo live in **four** different homes, none of them central:

1. **`.env` / `.env.example` + Dokploy per-service env** — the bulk: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, all `CLOVER_*`, `DELIVERECT_*`, the four internal service-to-service bearer tokens (`KDS_INTERNAL_ADMIN_TOKEN`, `INVENTORY_INTERNAL_TOKEN`, `ANALYTICS_ADMIN_TOKEN`/`ADMIN_TOKEN`), the crew auth secrets, and the two AES-GCM master keys.
2. **`app_setting` table, `category=secret`, AES-GCM at rest** (ADR-0016/0017/0018, MEMORY 2026-05-27 pivot) — operator-rotatable keys: canonically the DeepSeek API key (`ai.deepseek_api_key`) and Clover HMAC/config. This is a *runtime, UI-editable, hot-reloadable* store and is deliberately **not** in scope to replace.
3. **GitHub Actions secrets** — CI/deploy-only: `SENTRY_AUTH_TOKEN`, the browser `*_SENTRY_DSN` build args, `DOKPLOY_WEBHOOK_*`, `SLACK_WEBHOOK_URL`.
4. **1Password (via `.env.tpl` `op://` URIs)** — the Dokploy control-plane creds: `DOKPLOY_API_KEY`, `DOKPLOY_*_COMPOSE_ID`, `DOKPLOY_WEBHOOK_*`, `SENTRY_*`.

The pain: the same secret (e.g. `SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`, the `ANALYTICS_ADMIN_TOKEN`/`ADMIN_TOKEN` pair) is hand-duplicated across **multiple `compose-dokploy/*.yml` files and must be kept byte-identical** or services 401/503 each other. There is no audit trail of who read a production secret and no single rotate-once surface.

### What Infisical buys
- **One source of truth** for runtime/bootstrap secrets, with **per-environment** (`dev`/`prod`) values at the same key path — kills the cross-compose-file duplication for the shared-pair secrets.
- **Injection with zero app-code change.** `infisical run -- <cmd>` fetches the env's secrets and injects them as **environment variables into the child process** — no `.env` written to disk (confirmed against Infisical CLI v0.43.x; the no-disk property is specific to `run`, not `export`). Our apps already read `process.env` through `getServerEnv()` / zod `ConfigSchema`, so **nothing in `lib/env.ts` or `src/config.ts` changes**.
- **Audit + central rotation.** Every fetch is logged against the machine identity; rotating a shared secret is a single edit instead of N compose edits + N redeploys.
- **Least-privilege read-only identities.** The AI-agent and CI identities can be fenced to `dev`-only, read-only RBAC, so a leaked agent credential cannot read prod or write anything.

### The honest 'secret-zero' caveat — READ THIS
Infisical removes app secrets from Dokploy/GitHub but **cannot remove the one credential needed to talk to Infisical.** That irreducible "secret zero" is:
- **Prod (Dokploy):** the `rop-prod` machine identity's `CLIENT_ID` + `CLIENT_SECRET`, which now live in Dokploy per-service env (replacing the *pile* of app secrets that were there). **Net change: N secrets → 1 scoped credential + central control.** Not zero secrets in Dokploy — fewer, and one tightly-scoped one.
- **CI (GitHub Actions):** with **OIDC** there is *no* stored Infisical credential — GitHub mints a short-lived token, Infisical exchanges it. This is the cleanest secret-zero outcome; use it for `rop-ci`.
- **Local dev:** humans use interactive `infisical login` (browser → macOS Keychain), so there is **no** committed credential at all.

What stays out of Infisical permanently (do not migrate):
- **The bootstrap set** every consumer needs *before/independent of* an Infisical fetch can succeed: the database URLs, the two AES-GCM master keys, `SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN` (this repo's documented bootstrap-only set in `backoffice-web/AGENTS.md` rule 16). *(Rationale below in §3 — some of these are debatable; the conservative default is to keep the irreducible boot-critical ones in Dokploy env and migrate the rest. The plan picks a deliberate line and documents it.)*
- **CI deploy webhooks / Dokploy control-plane creds** (`DOKPLOY_WEBHOOK_*`, `DOKPLOY_API_KEY`, `DOKPLOY_*_COMPOSE_ID`) — these gate access to the deploy platform itself and must **not** depend on a successful Infisical fetch (no circular bootstrap). Keep as GitHub Actions secrets / 1Password.
- **The self-hosted Infisical instance's own `ENCRYPTION_KEY` / `AUTH_SECRET` / DB URL** — if its `ENCRYPTION_KEY` is lost, **every secret in Infisical is unrecoverable.** Back it up to a *separate* store (1Password), never into Infisical.

---

## 2. Target architecture

### One project, folder-per-app, two environments
Single Infisical project (`${INFISICAL_PROJECT_SLUG}` / `${INFISICAL_PROJECT_ID}`) with environments **`dev`** and **`prod`** (add `staging` only if you created it). This mirrors the monorepo and stays under the free-tier 3-project / 3-environment cap.

Folder layout inside each environment (folders are the secret-side analog of our app/package boundaries; keep nesting **shallow** — secret-import propagation breaks past ~3 levels):

```
/                         (project root)
├── /common               # cross-cutting, shared values (see note)
├── /kds-api
├── /kds-web
├── /analytics-api
├── /backoffice-web
├── /inventory-api
└── /crew-web
```

`/common` holds values genuinely shared by ≥2 apps (e.g. the `CLOVER_*` pair shared by `kds-api`+`analytics-api`, `SENTRY_ENVIRONMENT`). Each app container stacks `--path=/common --path=/<app>`. **Gotcha — `--path` is FIRST-WINS** (opposite of normal env layering): to let app-specific values override `/common`, put the **app path first**: `--path=/<app> --path=/common`. Verify the merge with `infisical run ... -- printenv | sort`.

> Static sites (`legal-site`, `marketing-site`) have **zero** env dependencies (nginx serves prebuilt HTML) — **no Infisical integration, no folder, no identity.** Leave them exactly as they are.
> `order-web` has a Dockerfile but no secrets in the current inventory — create its folder only when it grows real secrets.

### Three read-only machine identities + how each consumer authenticates

| Identity | Auth method | Used by | Scope (RBAC) | Lifetime knobs |
|---|---|---|---|---|
| **`rop-prod`** | Universal Auth (`CLIENT_ID`+`CLIENT_SECRET`) | Prod containers via Dokploy | **read** on `secrets`, **`prod`** env only, all app paths | Access Token Period (renewable, effectively non-expiring for always-on containers); Client Secret TTL finite + rotation reminder |
| **`rop-dev-agent`** | Universal Auth (`CLIENT_ID`+`CLIENT_SECRET`) | Local dev automation + **AI agents (Codex + Claude Code MCP)** | base role **No Access** + Additional Privilege: subject `secrets`, action `[read]`, condition `environment $eq dev` | Short Access Token TTL (e.g. 3600s); finite Client Secret TTL |
| **`rop-ci`** | **OIDC** (no stored secret) | GitHub Actions | **read**, scoped env per workflow (`prod` for deploy-time secret fetch, or a `/ci` path) | Token lives only for the job |

The **4 consumers** and their auth path:

1. **Prod / Dokploy** → `rop-prod` Universal Auth. Container entrypoint runs `infisical run --method=universal-auth ... -- <start cmd>`. Secret-zero (`ROP_PROD_CLIENT_ID`/`ROP_PROD_CLIENT_SECRET` + `INFISICAL_PROJECT_ID` + `INFISICAL_API_URL` + `INFISICAL_SECRET_ENV=prod`) lives in Dokploy per-service env.
2. **Local dev (humans)** → interactive `infisical login` (browser, SSO-capable, stored in macOS Keychain). No credential committed. `pnpm dev` scripts wrapped with `infisical run`.
3. **AI agents (Codex CLI + Claude Code)** → `rop-dev-agent`, read-only/dev-only, via either the **Infisical MCP server** (`@infisical/mcp`, on-demand secret lookup in chat) or the **`infisical run -- pnpm test`** injection path (preferred for running the app/tests — nothing surfaced to the model).
4. **GitHub Actions CI** → `rop-ci` via **OIDC** (`Infisical/secrets-action`, `permissions: id-token: write`). No Infisical credential stored in GitHub.

> **Read-only is enough for all three identities.** No consumer in this plan *writes* secrets through Infisical — humans edit in the UI, CI only reads at deploy-time. The MCP server *advertises* write/admin tools, but `rop-dev-agent`'s RBAC denies them at the API. **The RBAC is the guardrail, not the tool list.**
> **Trusted-IP allowlisting is a paid feature** — on free/self-hosted-OSS you cannot pin identities to the Oracle host's egress IP. Compensate with short TTLs + read-only/dev-only RBAC + audit logs.

---

## 3. Secret-import list — THE key deliverable

Destination legend:
- **`Infisical:prod` (+`dev`)** → migrate to the named folder, both environments. App reads it via injected env var; **env-var stays as break-glass fallback through Phase 2** (see §8).
- **STAYS in env (bootstrap)** → never enters Infisical; remains in Dokploy per-service env (and `.env` for local). Irreducible / boot-critical.
- **GitHub Actions only** → CI/deploy secret; stays a GH Actions secret or 1Password. Not in Infisical (avoids circular deploy-bootstrap dependency).
- **`app_setting` (unchanged)** → already in the encrypted DB store; not moved.

Folder column = the Infisical folder when destination is Infisical. "Apps" = which apps read it (from inventory).

### 3a. Runtime secrets → migrate to Infisical

| Secret | Destination | Folder | Apps that read it | Notes |
|---|---|---|---|---|
| `REDIS_URL` | Infisical:prod+dev | `/common` | kds-api, backoffice-web | Shared; one Infisical key, per-env value. *(Note: NOT a DB-boundary violation — it's a cache/session URL, fine to share.)* |
| `SESSION_SECRET` | **STAYS in env (bootstrap)** | — | kds-api, backoffice-web | Boot-critical session HMAC; in `AGENTS.md` rule-16 bootstrap set. Must be identical across kds-api+backoffice — keep in Dokploy env both stacks. **See §3c for the argument to migrate later.** |
| `CLOVER_TOKEN` | Infisical:prod (+dev blank) | `/common` | kds-api, analytics-api | Must match across both; central key kills the duplication. |
| `CLOVER_APP_ID` | Infisical:prod | `/kds-api` | kds-api | OAuth app id. |
| `CLOVER_APP_SECRET` | Infisical:prod | `/kds-api` | kds-api | OAuth app secret. |
| `CLOVER_WEBHOOK_AUTH_CODE` | Infisical:prod | `/common` | kds-api, analytics-api | Webhook signature verify; shared. |
| `DELIVERECT_WEBHOOK_SECRET` | Infisical:prod | `/kds-api` | kds-api | HMAC for Deliverect webhooks. |
| `KDS_INTERNAL_ADMIN_TOKEN` | **STAYS in env (bootstrap)** | — | kds-api, backoffice-web | In rule-16 bootstrap set. Cross-stack shared bearer; **§3c argues for migration** but conservative default keeps it in Dokploy env. |
| `INVENTORY_INTERNAL_TOKEN` | Infisical:prod (+dev blank) | `/common` | inventory-api, backoffice-web | Cross-stack shared bearer (inventory.yml ⇄ backoffice.yml). **Prime candidate** — exactly the kind of byte-identical duplication Infisical fixes. Not in the bootstrap set. |
| `CREW_SESSION_SECRET` | Infisical:prod | `/inventory-api` | inventory-api | Crew PIN-auth session HMAC. Must differ from `CREW_PIN_PEPPER`. |
| `CREW_PIN_PEPPER` | Infisical:prod | `/inventory-api` | inventory-api | PIN index pepper; rotation requires re-seed. |
| `ANALYTICS_ADMIN_TOKEN` | Infisical:prod (+dev) | `/common` | analytics-api, backoffice-web | REQUIRED (backoffice fails-fast). **Same value as `ADMIN_TOKEN` below** — model as ONE Infisical key, inject under both names (see §4 note). |
| `ADMIN_TOKEN` | Infisical:prod (+dev) | `/common` | analytics-api | analytics-api's name for the same shared bearer. Inject the single `/common` value into `ADMIN_TOKEN` for analytics and `ANALYTICS_ADMIN_TOKEN` for backoffice. |
| `WEB_LOGIN_PASSWORD_HASH` | Infisical:prod | `/kds-api` | kds-api | bcrypt hash of floor login password. |
| `WEB_LOGIN_USERNAME` | Infisical:prod | `/kds-api` | kds-api | Marked `config` in inventory but pairs with the hash; keep together. |
| `SENTRY_DSN` | Infisical:prod | `/common` | kds-api, analytics-api | Server-side DSN (DSN values are public, but central mgmt is convenient). |
| `DEEPSEEK_API_KEY` | **`app_setting` (unchanged)** | — | backoffice-web | **Already migrated to `app_setting` `ai.deepseek_api_key` (encrypted, ADR-0017 §6 superseded).** The env var is a *deprecated* transition fallback (#265). **Do NOT route this through Infisical** — that would re-fragment a key the repo deliberately moved to the hot-reloadable operator store. Drop the env fallback entirely once the DB row is set in prod. (See §3d.) |

### 3b. Bootstrap secrets → STAY in env (Dokploy per-service + local `.env`), never in Infisical

| Secret | Apps | Why it stays |
|---|---|---|
| `DATABASE_URL` | kds-api, kds-web, backoffice-web, analytics-api | KDS/auth Postgres. Needed by Prisma **migrate sidecars** (`compose-dokploy/kds.yml`) that run *before* the app via `prisma.config.ts` → `process.env.DATABASE_URL`. The migrate container is the worst place to add an Infisical dependency. Bootstrap set, rule 16. |
| `INVENTORY_DATABASE_URL` | inventory-api, crew-web, backoffice-web | Inventory Postgres (Iron Law 1, own DB). Same migrate-sidecar reasoning. |
| `APP_SETTING_ENCRYPTION_KEY` | backoffice-web | AES-GCM master key for the `app_setting` secret store. If lost, every encrypted row is unreadable. **Circular if stored in Infisical** (you'd need it to read the store it protects). Back up in 1Password. Bootstrap set. |
| `APP_SETTING_ENCRYPTION_KEY_PREVIOUS` | backoffice-web | Optional rotation fallback for the above; same reasoning. |
| `AI_TOKEN_ENCRYPTION_KEY` | kds-api | AES-GCM master key for `kds_provider_configs` (Deliverect creds). Same "key that protects an at-rest store" reasoning — keep out-of-band. |
| `SESSION_SECRET` | kds-api, backoffice-web | (listed above) bootstrap set. |
| `KDS_INTERNAL_ADMIN_TOKEN` | kds-api, backoffice-web | (listed above) bootstrap set. |
| `POSTGRES_PASSWORD` | (dev compose) | Local `docker-compose.dev.yml` only. Dev-only, default `postgres`. No prod relevance. |
| `GLITCHTIP_*`, `GRAFANA_ADMIN_PASSWORD` | (observability) | Oracle observability stack `.env.observability` — separate lifecycle from the app suite; GlitchTip removed 2026-05-28. Out of scope. |

### 3c. The four "bootstrap" secrets — the defensible line
The repo's existing bootstrap set is exactly `DATABASE_URL`, `APP_SETTING_ENCRYPTION_KEY`, `KDS_INTERNAL_ADMIN_TOKEN`, `SESSION_SECRET` (rule 16). Two of those four (`SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`) are *not* technically required before an Infisical fetch — they're just secrets the app reads at request-time. **You could migrate them.** The plan's deliberate choice:

- **Keep `DATABASE_URL` + the encryption keys in env (genuinely boot/migrate-critical, or self-protecting).** Non-negotiable.
- **Treat `SESSION_SECRET` + `KDS_INTERNAL_ADMIN_TOKEN` as "migrate-eligible, but defer to a later phase."** Migrating them is the bigger duplication win (both are cross-stack-shared), but they're also the highest-blast-radius if Infisical injection is misconfigured on first boot. Move them **last**, only after every other secret has run Infisical-primary in prod for a sustained window. Until then they stay in Dokploy env and rule 16 stays accurate.

This keeps Phase-1/2 cutover low-risk and leaves a clean follow-up (`SESSION_SECRET`/`KDS_INTERNAL_ADMIN_TOKEN` → Infisical) that, when done, also lets you tighten rule 16's bootstrap set to just `DATABASE_URL` + the encryption keys.

### 3d. CI / deploy-only → GitHub Actions secrets (or 1Password), NOT Infisical

| Secret | Where it stays | Why not Infisical |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | GH Actions secret | Build-time sourcemap upload. Could move to Infisical:`/ci`, but it's CI-only and OIDC already covers CI auth — low value, keep simple. |
| `SENTRY_ORG` | GH Actions / 1Password | CI-only config. |
| `KDS_WEB_SENTRY_DSN`, `BACKOFFICE_SENTRY_DSN`, `CREW_SENTRY_DSN` | GH Actions secret | **Build-time** ARGs baked into browser bundles via BuildKit `--secret` (see Dockerfiles' `NEXT_PUBLIC_SENTRY_DSN`). Consumed at `docker build`, not runtime — Infisical's runtime injection can't reach them. Keep as GH build secrets. |
| `DOKPLOY_WEBHOOK_KDS/ANALYTICS/BACKOFFICE/CREW/LEGAL/MARKETING/INVENTORY` | GH Actions / 1Password | Deploy-trigger webhooks. **Must not depend on Infisical** (circular: you'd need Infisical to deploy the thing that runs Infisical). |
| `DOKPLOY_API_KEY` | GH Actions / 1Password | Dokploy control-plane auth (sync-compose-to-dokploy.yml). Same circular-dependency reason. |
| `DOKPLOY_KDS/ANALYTICS/BACKOFFICE/CREW/LEGAL/MARKETING_COMPOSE_ID` | GH Actions / 1Password | Deploy identifiers; CI-only. |
| `SLACK_WEBHOOK_URL` | GH Actions secret | Deploy-failure alerts (slack-notify.yml); independent of app runtime. |

### 3e. Non-secret config → leave in compose/env (do NOT bloat Infisical)
All `kind:"config"` entries — `CLOVER_REGION`, `CLOVER_BASE_URL`, `DELIVERECT_API_URL`, `DELIVERECT_STAGING_API_URL`, all `WEBAUTHN_RP_ID/RP_NAME/ORIGIN`, every `INTERNAL_*_URL` / `*_BASE_URL` / `NEXT_PUBLIC_*`, `BOARD_TIMEZONE`, `STORE_TIMEZONE`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `RAW_EXPORT_DIR`, all `*_PORT`, the `DAILY_RESET_*` / worker-concurrency / reconcile knobs, `GITHUB_REPO_OWNER/NAME`, `CLOVER_MERCHANT_ID`, `NEXT_PUBLIC_DEFAULT_MERCHANT_ID`. These are non-sensitive and many are **build-time `NEXT_PUBLIC_*`** (baked into bundles, unreachable by runtime injection). Keep them in `compose-dokploy/*.yml` `environment:` blocks where `validate-compose-env.py` already guards them. *(Optional: you may park a few shared ones like `SENTRY_ENVIRONMENT` in `/common` for convenience, but there's no security reason to.)*

> **`secretImportCount` = 18** distinct secrets routed *into* Infisical (the §3a "Infisical:" rows, counting the `ANALYTICS_ADMIN_TOKEN`/`ADMIN_TOKEN` pair as one logical key delivered under two names, and excluding the two bootstrap-deferred and the `app_setting` DeepSeek key). The remaining inventory secrets stay put per §3b/§3d.

---

## 4. Per-app code changes

The unifying principle: **Infisical injects env vars; app code that reads `process.env` does not change.** `apps/backoffice-web/lib/env.ts` (`getServerEnv()` zod parse of `process.env`) and the Fastify `src/config.ts` `ConfigSchema` stay **byte-for-byte identical**. No `@infisical/sdk` dependency is added to any app. This is the whole point of the `infisical run` model.

### 4a. `.infisical.json` placement (commit these — they hold no secrets)
Create one at each app dir that will be wrapped, all pointing at the same project:

```jsonc
// apps/backoffice-web/.infisical.json  (and one per app: kds-api, kds-web,
// analytics-api, inventory-api, crew-web)
{
  "workspaceId": "${INFISICAL_PROJECT_ID}",
  "defaultEnvironment": "dev"
}
```
Generated by running `infisical init` in each app dir (or hand-write — `workspaceId` is the Project ID; do not paste the wrong value). Safe to commit. `gitBranchToEnvironmentMapping` can be added later to auto-select `prod` on `main`; not needed for the dev loop.

### 4b. Dev scripts wrapped with `infisical run --`
**The repo runs dev from the root via pnpm filters, not per-app**, so the cleanest wrap is at the **root** `package.json` scripts (each child still resolves its own `apps/<app>/.infisical.json` because the filtered process runs with that cwd). Change `package.json`:

```jsonc
// BEFORE
"dev":     "pnpm --parallel --filter @rop/kds-api --filter @rop/kds-web dev",
"dev:all": "pnpm --parallel --no-bail --filter @rop/kds-api --filter @rop/inventory-api --filter @rop/kds-web --filter @rop/analytics-api --filter @rop/backoffice-web dev",

// AFTER — wrap the whole parallel run once; --watch restarts on secret edits
"dev":     "infisical run --env=dev --path=/common -- pnpm --parallel --filter @rop/kds-api --filter @rop/kds-web dev",
"dev:all": "infisical run --env=dev --path=/common -- pnpm --parallel --no-bail --filter @rop/kds-api --filter @rop/inventory-api --filter @rop/kds-web --filter @rop/analytics-api --filter @rop/backoffice-web dev",
```

> **Caveat — root-level wrap injects ONE merged env into all parallel children.** That's fine for dev (overlapping keys like `REDIS_URL` are identical across apps) and simplest. If you ever need strict per-app dev isolation, instead wrap the **per-app** `dev` script (e.g. `apps/backoffice-web/package.json` → `"dev": "infisical run --env=dev --path=/backoffice-web --path=/common -- next dev -p 3001"`) and drop the wrap from root. Pick one; don't double-wrap.
> **`infisical run` with a logged-in human session does NOT need `--projectId`** (the `.infisical.json` binds it). `--projectId` is only mandatory for *machine-identity* (token) auth — see §4c/§5/§6.
> For self-hosted, devs set `INFISICAL_API_URL=${INFISICAL_API_URL}` once in their shell profile (or pass `--domain` on login) so the CLI doesn't silently hit Infisical Cloud.

### 4c. Dockerfile entrypoint changes (prod, `rop-prod` machine identity)
Add the CLI to each runtime stage and wrap the existing `CMD` with an entrypoint that authenticates at **runtime** (never bake a token at build time — build-layer tokens don't survive to `CMD`). The repo has two base flavors:

**Alpine apps (`kds-api`, `kds-web`, `analytics-api`, `inventory-api`, `crew-web`)** — runtime stage already does `apk add --no-cache curl`. Extend it and pin the CLI:
```dockerfile
# in the `runtime` stage, replace the curl line:
RUN apk add --no-cache bash curl \
 && curl -1sLf 'https://artifacts-cli.infisical.com/setup.alpine.sh' | bash \
 && apk add "infisical=<PINNED_VERSION>"
ENV INFISICAL_DISABLE_UPDATE_CHECK=true
COPY apps/<app>/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# replace: CMD ["node", "dist/index.js"]
CMD ["/usr/local/bin/entrypoint.sh"]
```

**Debian app (`backoffice-web`, bookworm-slim)** — runtime stage installs `openssl ca-certificates curl`. Extend:
```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl bash \
 && curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash \
 && apt-get update && apt-get install -y infisical=<PINNED_VERSION> \
 && rm -rf /var/lib/apt/lists/*
ENV INFISICAL_DISABLE_UPDATE_CHECK=true
COPY apps/backoffice-web/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# replace: CMD ["node", "apps/backoffice-web/server.js"]
CMD ["/usr/local/bin/entrypoint.sh"]
```

**`apps/<app>/entrypoint.sh`** (one per Node app; `--path` differs per app, app start cmd differs):
```sh
#!/bin/sh
set -e
# Authenticate dynamically (machine identity) and inject prod secrets as env
# vars into the app process. `exec` keeps the app as PID 1 so SIGTERM from
# Dokploy/Traefik on redeploy reaches Node (no slow/forced kills).
exec infisical run \
  --method=universal-auth \
  --client-id="$INFISICAL_MACHINE_CLIENT_ID" \
  --client-secret="$INFISICAL_MACHINE_CLIENT_SECRET" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_SECRET_ENV" \
  --domain="$INFISICAL_API_URL" \
  --path=/backoffice-web --path=/common \
  -- node apps/backoffice-web/server.js
```
Per-app `-- <start cmd>` and the `--path=/<app>` line vary:
- `kds-api`: `--path=/kds-api --path=/common -- node dist/index.js`
- `kds-web`: `--path=/kds-web --path=/common -- node apps/kds-web/server.js`
- `analytics-api`: `--path=/analytics-api --path=/common -- node dist/src/service.js`
- `inventory-api`: `--path=/inventory-api --path=/common -- node dist/index.js`
- `crew-web`: `--path=/crew-web --path=/common -- node apps/crew-web/server.js`

> **Prisma migrate sidecars are special.** The `migrate`/`migrate-auth` containers in `compose-dokploy/kds.yml` (and inventory) run *before* the app and read `DATABASE_URL` from `process.env` via `prisma.config.ts`. Because **`DATABASE_URL` stays in Dokploy env (bootstrap)**, the migrate sidecars **need no Infisical wrapping at all** — leave them untouched. This is a deliberate benefit of keeping the DB URL out of Infisical.
> **Two-name injection for the analytics bearer:** the single `/common` Infisical key (call it `ANALYTICS_ADMIN_TOKEN`) is injected as-is into backoffice; for analytics-api, add a tiny shim in its entrypoint before `exec` — `export ADMIN_TOKEN="$ANALYTICS_ADMIN_TOKEN"` — so one Infisical key feeds both env-var names. (Alternatively store both keys in `/common`; the shim is less duplication.)

### 4d. Compose changes (Dokploy secret-zero wiring)
In each `compose-dokploy/<app>.yml`, **remove** the now-Infisical-managed `environment:` entries (per §3a) and **add** the secret-zero block. Crucially: **Dokploy does NOT auto-inject UI-set env vars into compose containers** — they're only written to a `.env`. You must reference them explicitly. For `backoffice.yml`:
```yaml
    environment:
      NODE_ENV: production
      PORT: 3001
      HOSTNAME: 0.0.0.0
      # --- BOOTSTRAP (stay in Dokploy env, NOT Infisical) ---
      DATABASE_URL: ${DATABASE_URL}
      APP_SETTING_ENCRYPTION_KEY: ${APP_SETTING_ENCRYPTION_KEY}
      SESSION_SECRET: ${SESSION_SECRET}                     # deferred-migrate (§3c)
      KDS_INTERNAL_ADMIN_TOKEN: ${KDS_INTERNAL_ADMIN_TOKEN} # deferred-migrate (§3c)
      # --- SECRET ZERO (Infisical machine identity) ---
      INFISICAL_MACHINE_CLIENT_ID: ${ROP_PROD_CLIENT_ID}
      INFISICAL_MACHINE_CLIENT_SECRET: ${ROP_PROD_CLIENT_SECRET}
      INFISICAL_PROJECT_ID: ${INFISICAL_PROJECT_ID}
      INFISICAL_SECRET_ENV: prod
      INFISICAL_API_URL: ${INFISICAL_API_URL}
      # --- NON-SECRET CONFIG (stay; many are build-time NEXT_PUBLIC_*) ---
      WEBAUTHN_RP_ID: ${WEBAUTHN_RP_ID}
      # ...remaining config entries unchanged...
```
Set the five `ROP_PROD_*` / `INFISICAL_*` values in **Dokploy → service → Environment** for each stack. **Update `scripts/validate-compose-env.py`** so the migrated secrets are no longer required as Dokploy entries and the new `INFISICAL_*` keys are recognized (otherwise `pnpm` env-drift check fails).

---

## 5. AI agent integration (`rop-dev-agent`, read-only, dev-only)

Both agents use the **same** `rop-dev-agent` Universal Auth identity, scoped (base role **No Access** + Additional Privilege `secrets/read` with `environment $eq dev`). The MCP server ships destructive tools, but the API denies them for this identity — the RBAC is the boundary.

### 5a. Claude Code — `.mcp.json` at repo root (project-scoped, prompts on first use)
```json
{
  "mcpServers": {
    "infisical": {
      "command": "npx",
      "args": ["-y", "@infisical/mcp"],
      "env": {
        "INFISICAL_AUTH_METHOD": "universal-auth",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID": "${ROP_DEV_AGENT_CLIENT_ID}",
        "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET": "${ROP_DEV_AGENT_CLIENT_SECRET}",
        "INFISICAL_HOST_URL": "${INFISICAL_API_URL}"
      }
    }
  }
}
```
Claude Code expands `${VAR}` from the shell, so export `ROP_DEV_AGENT_CLIENT_ID` / `ROP_DEV_AGENT_CLIENT_SECRET` in your shell (or a gitignored env file) — the committed `.mcp.json` holds no secret. Tell the agent the **projectId + `dev` env slug** in `AGENTS.md` (the MCP tools take those as call-time params and won't infer them).

### 5b. Codex CLI — `~/.codex/config.toml` (or project `.codex/config.toml`)
```toml
[mcp_servers.infisical]
command = "npx"
args = ["-y", "@infisical/mcp"]

[mcp_servers.infisical.env]
INFISICAL_AUTH_METHOD = "universal-auth"
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID = "${ROP_DEV_AGENT_CLIENT_ID}"
INFISICAL_HOST_URL = "${INFISICAL_API_URL}"

# Forward the secret from Codex's own shell env instead of hard-coding it:
env_vars = ["INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"]

# Belt-and-suspenders: make any write tool prompt (RBAC already denies them).
[mcp_servers.infisical.tools.create-secret]
approval_mode = "approve"
[mcp_servers.infisical.tools.update-secret]
approval_mode = "approve"
[mcp_servers.infisical.tools.delete-secret]
approval_mode = "approve"
```
Verify with `codex mcp` (a known issue, openai/codex#3441, sometimes prevents config-loaded servers from appearing — confirm the right file/global-vs-project and that the project is "trusted").

### 5c. Preferred fallback — `infisical run -- pnpm test` (nothing surfaced to the model)
For running the app or tests, agents should prefer **injection** over the MCP tools (secrets become env vars on the child process, never enter the chat):
```sh
export INFISICAL_TOKEN=$(infisical login --method=universal-auth \
  --client-id="$ROP_DEV_AGENT_CLIENT_ID" \
  --client-secret="$ROP_DEV_AGENT_CLIENT_SECRET" \
  --domain="$INFISICAL_API_URL" --silent --plain)
infisical run --projectId="$INFISICAL_PROJECT_ID" --env=dev --domain="$INFISICAL_API_URL" \
  --path=/backoffice-web --path=/common -- pnpm --filter @rop/backoffice-web test
```
`--projectId` is **mandatory** here (machine-identity token isn't bound to a project). `--silent --plain` makes `login` emit only the raw token.

---

## 6. CI changes (`rop-ci`, OIDC — no stored secret)

Configure `rop-ci` with **OIDC Auth** in Infisical: issuer `https://token.actions.githubusercontent.com`, subject hardcoded to `repo:example-org/restaurant-ops-platform:ref:refs/heads/main` (and/or `repo:example-org/restaurant-ops-platform:pull_request` for PR runs — **no globs**, per Infisical guidance), audience `https://github.com/example-org`. The resulting Identity ID is public and safe to commit.

The current `ci.yml` (`runs-on: [self-hosted, mac]`, lint+build+test) uses **no app secrets today** — tests run against a dummy `DATABASE_URL` per the E2E memory note. So the CI step is **only needed where a job actually requires a secret** (e.g. if/when a test needs a real `dev` secret, or a future deploy-prep job). Where needed, add:

```yaml
permissions:
  id-token: write   # REQUIRED for OIDC — its absence is the #1 failure
  contents: read

steps:
  - uses: actions/checkout@v6
  - uses: Infisical/secrets-action@v1.0.16   # pin to a tag, not a moving ref
    with:
      method: "oidc"
      identity-id: "<rop-ci-identity-uuid>"   # public, safe to commit
      project-slug: "${INFISICAL_PROJECT_SLUG}"
      env-slug: "dev"            # case-sensitive; use prod only for deploy-prep jobs
      domain: "${INFISICAL_API_URL}"
      secret-path: "/common"
      # export-type defaults to "env" -> later steps read injected vars
  - name: Run tests
    run: pnpm test   # never `echo $SECRET`; GitHub masks but don't print
```

> **Self-hosted mac runners + OIDC:** the OIDC token is minted by GitHub regardless of runner location, so `runs-on: [self-hosted, mac]` is fine. If your self-hosted Infisical uses a private CA, set `NODE_EXTRA_CA_CERTS` on the runner.
> **Do NOT** move `DOKPLOY_WEBHOOK_*` / `DOKPLOY_API_KEY` into Infisical for `build-images.yml` — keep them GH Actions secrets (circular deploy dependency, §3d). `build-images.yml` is unchanged by this migration except where a *build-time app secret* might later be sourced; the Sentry build secrets stay GH-side because they're consumed at `docker build`.

---

## 7. Doc changes (draft text, ready to paste)

### 7a. New ADR — `docs/decisions/0020-adopt-infisical-for-runtime-secrets.md`
> **Use 0020** — `0018` and `0019` already collide/exist; `0020` is the next clean number. Add the index row to `docs/decisions/README.md`: `| [0020](0020-adopt-infisical-for-runtime-secrets.md) | Adopt Infisical for runtime secrets | Accepted |`.

```markdown
# ADR-0020: Adopt Infisical for runtime secrets

- **Status**: Accepted
- **Date**: 2026-05-30
- **Deciders**: @example-org

## Context

Runtime/bootstrap secrets are scattered across four homes — `.env` files,
Dokploy per-service env, GitHub Actions secrets, and 1Password — with the same
shared-pair secrets (`SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`,
`ANALYTICS_ADMIN_TOKEN`/`ADMIN_TOKEN`, `INVENTORY_INTERNAL_TOKEN`) hand-
duplicated across multiple `compose-dokploy/*.yml` files and required to be
byte-identical or services 401/503 each other. There is no audit trail of
production-secret reads and no single rotate-once surface. This is distinct
from the operator-rotatable `app_setting` store (ADR-0016/0017/0018), which is
a runtime, UI-editable, hot-reloadable layer and is NOT the problem here.

## Decision

Adopt a single self-hosted Infisical project as the source of truth for
runtime/infrastructure secrets, injected via `infisical run -- <cmd>` (env-var
injection into the child process, no `.env` on disk, no app-code SDK change —
apps keep reading `process.env` through `getServerEnv()` / `ConfigSchema`).

- One project, environments `dev` + `prod`, folder-per-app + `/common`.
- Three read-only machine identities: `rop-prod` (Universal Auth, prod
  containers via Dokploy), `rop-dev-agent` (Universal Auth, dev-only read-
  only, for local dev + AI agents), `rop-ci` (OIDC, no stored secret).
- Prod containers wrap their entrypoint with `infisical run --method=
  universal-auth ... -- <start>`; the machine-identity client id/secret is the
  one "secret zero" that stays in Dokploy per-service env.
- The bootstrap set stays in env and is NEVER stored in Infisical:
  `DATABASE_URL` / `INVENTORY_DATABASE_URL` (needed by Prisma migrate sidecars
  before the app boots), `APP_SETTING_ENCRYPTION_KEY` (+ `_PREVIOUS`) and
  `AI_TOKEN_ENCRYPTION_KEY` (self-protecting AES-GCM master keys — circular if
  stored in the thing they protect). `SESSION_SECRET` and
  `KDS_INTERNAL_ADMIN_TOKEN` are migrate-eligible but DEFERRED to a later phase
  (highest blast radius) and stay in env for now.
- CI deploy webhooks and the Dokploy control-plane creds (`DOKPLOY_WEBHOOK_*`,
  `DOKPLOY_API_KEY`, `DOKPLOY_*_COMPOSE_ID`) stay GitHub-Actions/1Password
  secrets — they gate the deploy platform and must not depend on an Infisical
  fetch (no circular bootstrap).
- The DeepSeek API key stays in the `app_setting` encrypted store
  (`ai.deepseek_api_key`); it is NOT routed through Infisical.

## Consequences

- Easy: rotate a shared secret once instead of editing N compose files +
  redeploying N stacks; audit every production-secret read; fence AI-agent and
  CI access to dev-only read-only via RBAC.
- Hard / new risk: "secret zero" is irreducible — the `rop-prod`
  client secret lives in Dokploy env (scope tightly, rotate, keep audit on).
  A misconfigured first-boot injection can take a stack down; the phased
  parallel-run with env-var fallback (the migration plan) mitigates this.
- The self-hosted Infisical instance's own `ENCRYPTION_KEY` becomes a
  catastrophic-loss item — back it up to 1Password, separate from Infisical.
- Trusted-IP allowlisting is paid; on free/OSS we rely on short TTLs +
  read-only/dev-only RBAC instead.

## Alternatives considered

- **Do nothing (status quo).** Rejected: duplication + no audit + no central
  rotation is the actual pain.
- **Move everything into `app_setting`.** Rejected: `app_setting` is a runtime
  hot-reload layer inside one app's DB (backoffice); it can't serve bootstrap
  secrets that must exist before any app boots, nor cross-app/CI secrets.
- **One Infisical project per app.** Rejected for now: stronger blast-radius
  isolation but 6+ projects blows the free-tier 3-project cap and adds moving
  parts; folders mirror our monorepo and suffice. Graduate later if needed.
- **Keep secrets in Dokploy env only.** Rejected: that IS the status quo's
  duplication problem.
```

### 7b. Updated `apps/backoffice-web/AGENTS.md` — rule 16 (replace the existing rule 16 text)
```markdown
16. **Runtime secret sources, in order of precedence.**
    (a) **Bootstrap secrets stay in env** (Dokploy per-service / local `.env`),
        NEVER in Infisical or `app_setting`: `DATABASE_URL`,
        `APP_SETTING_ENCRYPTION_KEY` (+ `_PREVIOUS`), and — until the deferred
        migration in ADR-0020 lands — `SESSION_SECRET` and
        `KDS_INTERNAL_ADMIN_TOKEN`. These are boot/migrate-critical or self-
        protecting AES-GCM master keys.
    (b) **Other runtime/infra secrets come from Infisical** (ADR-0020),
        injected as env vars by `infisical run` at container start. App code
        reads them via `getServerEnv()` from `process.env` exactly as before —
        no SDK, no code change. The `rop-prod` machine-identity client
        id/secret is the only "secret zero" in Dokploy env.
    (c) **Operator-rotatable secrets stay in `app_setting`** `category=secret`,
        AES-GCM encrypted at rest, read via `lib/settings` (decrypts
        transparently, short-TTL cache, PUT invalidates) — see
        `lib/ai/deepseek-provider.ts`. The canonical example is
        `ai.deepseek_api_key`; the `DEEPSEEK_API_KEY` env var is a deprecated
        transition fallback (#265) and is NOT routed through Infisical.
    Precedence at read time is unchanged: DB `app_setting` row → env var
    (now Infisical-injected) → hardcoded default. New env-shaped *infra*
    secrets land in Infisical; new *operator-rotatable* secrets land in
    `app_setting` from day one.
```

> Also add a one-line pointer in root `AGENTS.md` under "Machine-enforced boundaries" / a new "Secrets" note: *"Runtime/infra secrets are sourced from Infisical (ADR-0020) and injected via `infisical run`; operator-rotatable secrets live in `app_setting` (ADR-0016/0018); the bootstrap set stays in Dokploy env."* And update `README.md`'s env-setup section to say local dev requires `infisical login` once + that `pnpm dev` is now `infisical run`-wrapped.

---

## 8. Phased execution plan

**Guiding rule: parallel-run with env-var as the precedence/fallback until prod has been Infisical-primary for a sustained window. Rollback at every phase is "flip one thing back," not a data restore, because originals persist until Phase 4.**

> **LOCAL-DEV-IS-RUNNING SAFETY NOTE.** A dev server may be running in another process/terminal right now. **Do not** edit the root/per-app `dev` scripts and assume a live reload — changing `package.json`'s `dev` to `infisical run -- ...` only affects the **next** `pnpm dev` invocation; an already-running server keeps using its current env. To avoid breaking a teammate's running server: (a) land the script change behind verification that `infisical login` works on that machine first; (b) communicate that the next `pnpm dev` requires `infisical login` to have been run; (c) keep a non-Infisical escape hatch (`pnpm dev:raw` that runs the old command) for the transition so a missing Infisical session doesn't hard-block local work. *(At plan-write time, no dev server was listening on 3001/4000/3100/4100 — only MCP helper processes — but treat the running-server case as live.)*

### Phase 0 — Provision (safe to do NOW; no Client Secrets needed for most of it)
- Create the project, `dev` + `prod` environments, the folder structure (`/common` + per-app).
- **Load secret VALUES** into `dev` and `prod` per §3a — UI paste (modest count, single-merchant) or a scripted `infisical secrets set KEY=VALUE --env <env> --path <folder>` loop driven from the existing `.env` (use `KEY=@file` for multiline; delete temp plaintext after). **Do not delete any originals.**
- Create the three identities. **`rop-ci` OIDC needs no secret** — wire it now. **`rop-prod` / `rop-dev-agent` Client Secrets are the gating artifact** — generate them when you're ready to wire prod/agents (they're the only thing you can't do "now").
- Commit `.infisical.json` files and the ADR/AGENTS doc changes (docs are CI-skipped, zero runtime risk).
- **Verification:** `infisical export --env prod --path /common --format dotenv | diff -` against the old `.env`/compose values → must match. `infisical run --env=dev ... -- printenv | sort` shows expected keys with correct `--path` precedence.

### Phase 1 — Shadow read / parallel run (needs `rop-dev-agent` secret for local+agents; `rop-prod` secret for prod)
- **Local + AI agents first** (lowest risk): wire `.mcp.json` / Codex config + the `infisical run`-wrapped dev scripts (with the `dev:raw` escape hatch). Devs run `infisical login` once. Both env-var and Infisical are present; if Infisical is down, env still wins because the wrapped command still inherits the shell env where missing keys fall through. Run for a few days.
- **Prod, one app at a time, dev-app order** (e.g. `crew-web` or `kds-web` before `kds-api`/`backoffice-web`): build the Infisical-wrapped image, set the five `INFISICAL_*`/`ROP_PROD_*` secret-zero vars in Dokploy, **but keep the migrated app secrets ALSO present in Dokploy env** so the env value remains the de-facto source (Infisical injects on top but matches). Deploy. Watch health + Sentry.
- **Verification per app:** container boots healthy; the secret-dependent path works (e.g. backoffice→analytics dashboards for `ANALYTICS_ADMIN_TOKEN`, backoffice→inventory writes for `INVENTORY_INTERNAL_TOKEN`); Infisical audit log shows the fetch from `rop-prod`.
- **Rollback:** revert the image CMD/entrypoint (or just unset the secret-zero vars and redeploy the prior image) — env values still drive the app. Zero data loss.

### Phase 2 — Flip precedence to Infisical-primary (prod last, one app/env at a time)
- Once an app shows parity over several deploys, **remove the migrated secret from Dokploy env** for that stack (so Infisical is now the *only* source), keeping only the bootstrap set + secret-zero. Order: `dev`-style apps → `analytics`/`inventory` → `backoffice`/`kds` last.
- Update `compose-dokploy/<app>.yml` to drop the migrated `environment:` entries and update `validate-compose-env.py`.
- **Verification:** same as Phase 1; plus confirm a *deliberately* broken Infisical fetch (wrong env slug in a throwaway test) fails closed in the expected way, proving Infisical is now load-bearing.
- **Rollback:** re-add the one `environment:` line (value still in 1Password/your records) and redeploy. Still no data restore.

### Phase 3 — Migrate the deferred two (`SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`)
- After all of Phase 2 has been stable in prod for a sustained window, move these two into Infisical `/common`, flip them per app (kds-api + backoffice must stay identical — one Infisical key, injected into both), and **then** tighten `AGENTS.md` rule 16's bootstrap set to just `DATABASE_URL` + the encryption keys.
- **Rollback:** these were the highest-risk; keep their env values handy for one more cycle.

### Phase 4 — Decommission
- Only after prod has run Infisical-primary (incl. the deferred two) for a sustained window: remove the migrated secrets from `.env.example` / `.env.tpl` / old compose comments, leaving the bootstrap set + secret-zero documented. Keep CI/deploy webhooks GH-side.
- Configure audit-log retention (self-hosted = unlimited/your DB; Cloud Pro = 90d) or stream to your log store.

### What's safe NOW vs needs the 3 Client Secrets
| Action | Needs a Client Secret? |
|---|---|
| Create project/envs/folders, load values, write ADR/AGENTS/`.infisical.json`, wire `rop-ci` OIDC, verify via `export`/`printenv` | **No** — do it all now |
| Wire local dev scripts + AI-agent MCP/injection | Needs **`rop-dev-agent`** Client Secret |
| Wire any prod container | Needs **`rop-prod`** Client Secret |

---

## 9. Open questions
(Listed in `openQuestions`.)

