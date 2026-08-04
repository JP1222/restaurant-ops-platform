# Infisical cutover runbook

> **Status:** historical — superseded by [OPERATIONS.md](../../OPERATIONS.md) (cutover executed; Infisical injection is live in prod).

> ⚠️ **Dokploy + Docker Swarm were removed after this runbook was written** (see
> the Dokploy-removal ADR). Deploy is now plain `docker compose` over SSH
> (`scripts/deploy-stack.sh`), so "set the token in Dokploy / four Dokploy
> composes" below means: put the secret-zero in the gitignored per-stack host
> env file `compose/<stack>.env` (template `.env.prod.example`) and
> redeploy that stack. The `with-infisical` injection mechanism is unchanged.
> Treat the Dokploy-specific tRPC/UI steps as historical; the Infisical flip
> itself still applies.

Exact steps to flip production onto Infisical. Everything here is **gated on a human** (real secret values + Infisical org actions + host access). The code (PR #291) is already merged/ready and is a **no-op until you do Step 3** — the `with-infisical` entrypoint runs the app unchanged when no `INFISICAL_*` env is present, so nothing changes in prod until you set those vars.

State at the time of writing:
- Infisical project `restaurant-ops-platform` (`00000000-0000-0000-0000-000000000000`), envs `dev` / `staging` / `prod`.
- **dev** populated (21 keys; config filled, secrets blank — correct for dev).
- **prod** populated with the 21-key structure + public config **and the real secret values** (10 secrets read from Dokploy and written to Infisical `prod`; the rest are blank in Dokploy too, correctly).
- Two read+write service tokens (dev, prod) saved in **1Password** (Personal vault, tag `Infisical`).
- All 6 app Dockerfiles wired (backoffice debian/apt; the 5 alpine via static binary). Build-validated.
- The compose YAMLs reference `${INFISICAL_TOKEN:-}` on the five secret-consuming services (`kds-api`, `kds-worker`, `analytics-api`, `backoffice-web`, `inventory-api`). So the only thing left to flip prod is **Step 3** — setting the token value in Dokploy.

---

## Step 1 — Fill the real PROD secret values — ✅ DONE

The 10 real secret values that exist in Dokploy were read and written into Infisical `prod` (root path `/`): `CLOVER_TOKEN`, `CLOVER_MERCHANT_ID`, `CLOVER_WEBHOOK_AUTH_CODE`, `INVENTORY_INTERNAL_TOKEN`, `CREW_SESSION_SECRET`, `CREW_PIN_PEPPER`, `WEB_LOGIN_PASSWORD_HASH`, `ANALYTICS_ADMIN_TOKEN`, `ADMIN_TOKEN`, `REDIS_URL`. The keys below that are blank in Dokploy today (`CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `DELIVERECT_WEBHOOK_SECRET`, `SENTRY_DSN`, `GITHUB_PIPELINE_TOKEN`, `INTERNAL_INVENTORY_API_URL`) were left blank in Infisical too — correct.

<details><summary>Original instructions (kept for re-runs / staging)</summary>

The real values live in Dokploy per-service env today. Put each into Infisical `prod` (root path `/`). The blanks to fill:

`CLOVER_TOKEN`, `CLOVER_MERCHANT_ID`, `CLOVER_WEBHOOK_AUTH_CODE`, `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `DELIVERECT_WEBHOOK_SECRET`, `INVENTORY_INTERNAL_TOKEN`, `CREW_SESSION_SECRET`, `CREW_PIN_PEPPER`, `WEB_LOGIN_PASSWORD_HASH`, `ANALYTICS_ADMIN_TOKEN`, `ADMIN_TOKEN` (same value as `ANALYTICS_ADMIN_TOKEN`), `SENTRY_DSN`, `GITHUB_PIPELINE_TOKEN`, `REDIS_URL` (prod), `INTERNAL_INVENTORY_API_URL` (prod).

Two ways:
- **UI** (simplest): open Infisical → `restaurant-ops-platform` → `prod` → paste each value. Values never leave your machine.
- **Have me push them**: paste the values to me (or unlock `op` so I can read them from Dokploy via the API) and I'll bulk-`POST` them with the prod token.

> Stays in env / NOT in Infisical (bootstrap): `DATABASE_URL`, `INVENTORY_DATABASE_URL`, `APP_SETTING_ENCRYPTION_KEY`, `AI_TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`. CI-only stays GitHub Actions: `DOKPLOY_WEBHOOK_*`, `SENTRY_AUTH_TOKEN`. (See ADR-0020 §3.)

</details>

> **GitHub Actions needs no `INFISICAL_*`.** Verified: no workflow under `.github/workflows/` references any migrated runtime secret (`CLOVER_*`, `ANALYTICS_ADMIN_TOKEN`, `ADMIN_TOKEN`, `INVENTORY_INTERNAL_TOKEN`, `CREW_*`, `REDIS_URL`, …). CI only uses build/ops-infra secrets (`ANTHROPIC_API_KEY`, `DOKPLOY_*`, `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`, `SLACK_WEBHOOK_URL`), which ADR-0020 keeps in GitHub Actions. The runtime secrets are only needed inside the prod containers, where the `with-infisical` entrypoint injects them.

## Step 2 — (optional) machine identity for the MCP

Only needed if you want the Infisical MCP for Codex/Claude Code. Create `rop-dev-agent` (Universal Auth, **read-only, `dev` only**), send me the Client ID, place the Client Secret per `.mcp.json.infisical.example`. Service tokens already cover everything else, so this is skippable.

## Step 3 — Set the secret-zero env in Dokploy (the flip)

The compose YAMLs already reference `${INFISICAL_TOKEN:-}` on the five services that consume migrated secrets. Set the token value in the **four** Dokploy composes those services live in:

| Dokploy compose | services that pick up the token |
| --- | --- |
| kds | `kds-api`, `kds-worker` |
| analytics | `analytics-api` |
| backoffice | `backoffice-web` |
| inventory | `inventory-api` |

Add **one** env var per compose — that is the whole secret-zero:

```
INFISICAL_TOKEN=<the PROD service token from 1Password>
```

`INFISICAL_PROJECT_ID`, `INFISICAL_API_URL`, `INFISICAL_SECRET_ENV=prod`, `INFISICAL_SECRET_PATH=/` are **baked as defaults** in `scripts/with-infisical.sh`, so they don't go in Dokploy unless you're overriding them (e.g. a staging stack would set `INFISICAL_SECRET_ENV=staging`).

Deliberately *not* wired (correct):
- `migrate` / `migrate-auth` — need only `DATABASE_URL`; keeping them off Infisical means a migration never blocks on Infisical being reachable.
- `kds-web` / `crew-web` / `order-web` — no runtime secrets to inject (least privilege), even though `kds-web`/`crew-web` carry the entrypoint.

**Automated** via the Dokploy tRPC API: for each of the four composes, `compose.one` → append `INFISICAL_TOKEN=…` to the existing `env` (read-modify-write, append-only — never blank the existing lines) → `compose.update`.

> During the transition the migrated secrets still exist in Dokploy env *and* in Infisical (identical values), so injection is safe whichever source wins. Only after Step 4 verifies the `[with-infisical] injecting…` log do you delete the now-duplicated app secrets from Dokploy env — then Infisical is the sole source.
>
> Leave the `${CLOVER_TOKEN}`-style references in the YAML: with the Dokploy values removed they resolve to empty strings, but `infisical run` **overrides existing env vars** — it adds the process env first, then overwrites same-named keys with the Infisical value (see `formatSecretsForShell` in the CLI's `run.go`; the `--secret-overriding` flag is unrelated — it only arbitrates personal-vs-shared secrets). So the app sees Infisical's value, not the empty one.

## Step 4 — Redeploy + verify

- Trigger a build/deploy (`gh workflow run build-images.yml` — user-gated) so the new entrypoint images ship.
- Verify a container logged `[with-infisical] injecting secrets from Infisical (env=prod ...)` and the app booted.
- Then (and only then) you can delete the now-duplicated app secrets from Dokploy per-service env, leaving just the one `INFISICAL_TOKEN` var + the bootstrap set (`DATABASE_URL`, `SESSION_SECRET`, `KDS_INTERNAL_ADMIN_TOKEN`, the encryption keys).

## Rollback (instant, per-service)

Remove the `INFISICAL_*` env vars from a service and redeploy → the `with-infisical` wrapper falls back to running the command unchanged. No image rebuild needed to revert behavior.

---

## What's already validated
- `infisical run` with the dev token injects all 21 dev secrets, correct values (tested on both bookworm + alpine).
- A real `docker build` of the exact Dockerfile lines succeeds on alpine; the wrapper passes through with no token.
- Wrapper passthrough (no credential → runs command unchanged).
