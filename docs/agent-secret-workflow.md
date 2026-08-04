# Agent Secret Workflow

This is the only supported secret workflow for local AI agents and deploy
operator tasks.

> **Dokploy + Docker Swarm were removed** (see the Dokploy-removal ADR). Deploy
> is now plain `docker compose` over SSH: `build-images.yml` builds on the Mac
> Mini, pushes GHCR, then SSHes to the Oracle host and runs
> `scripts/deploy-stack.sh <stack>`. The deploy secrets are therefore
> `ORACLE_SSH_KEY` + `ORACLE_SSH_HOST` (+ Sentry build secrets), which replaced
> the whole former `DOKPLOY_*` set. Runtime app secrets do **not** go through
> GitHub or this workflow at all — they are injected at container boot from
> Infisical by the `with-infisical` entrypoint ([ADR-0020](decisions/0020-adopt-infisical-for-runtime-secrets.md)).

## Source Of Truth

- 1Password vault: `Example Kitchen DevOps`
- 1Password item: `Example Kitchen Deploy`
- Repo template: `.env.tpl`

The template contains only `op://` references. Real secret values stay in
1Password.

## Local Claude Code

Start Claude Code from the repo root with:

```bash
op run --env-file=.env.tpl -- claude
```

Claude then receives the deploy environment variables for that process only.
The project `.claude/settings.json` allows the safe helper scripts and blocks
common secret-printing commands.

## Local Codex CLI

Start Codex from the repo root with:

```bash
op run --env-file=.env.tpl -- codex
```

Codex reads `AGENTS.md` for project instructions. Secrets are available only as
process environment variables injected by `op run`.

## Verify Agent Environment

Run:

```bash
op run --env-file=.env.tpl -- scripts/check-agent-secrets.sh
```

Expected result: every required deploy variable prints `ok`. The script never
prints values.

## Sync GitHub Repository Secrets

GitHub Actions uses GitHub repository secrets. GitHub does not automatically
resolve 1Password references in this repo.

To refresh the GitHub mirror from 1Password, run:

```bash
op run --env-file=.env.tpl -- scripts/sync-github-secrets-from-agent-env.sh
```

The script syncs the deploy secrets:

- `ORACLE_SSH_KEY`
- `ORACLE_SSH_HOST`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`

It sends values to `gh secret set` over stdin. Values do not appear in shell
arguments or logs.

## Who Uses GitHub Secrets

GitHub receives these values only after an operator runs the sync script from a
1Password-authenticated local shell. Once synced, GitHub Actions reads the
GitHub repo secrets directly; Actions does not read the Mac Mini's 1Password
vault at job runtime.

| Secret | Consumed by | Purpose |
|---|---|---|
| `ORACLE_SSH_KEY` | `build-images.yml` | SSH into the Oracle host to run `scripts/deploy-stack.sh <stack>` after each GHCR push. |
| `ORACLE_SSH_HOST` | `build-images.yml` | Host address for the SSH deploy step. |
| `SENTRY_AUTH_TOKEN` | `build-images.yml` | Build-time Sentry sourcemap/release upload. |
| `SENTRY_ORG` | `build-images.yml` | Sentry org slug for the build step. |

Self-hosted runners are execution hosts, not secret sources. The Mac Mini
runner receives masked environment variables from GitHub Actions just like any
runner would. It should not call `op` during CI.

## Validate Compose

There is no Dokploy env to validate anymore. Compose files are checked by the
`validate-compose.yml` workflow, which runs `docker compose config` over each
`compose/<stack>.yml`. To run it locally:

```bash
docker compose -f compose/kds.yml config -q
```

(The old `scripts/validate-compose-env.py` and `sync-compose-to-dokploy.yml`
were deleted with the Dokploy removal.)

## Production Runtime Secrets

Production app containers fetch their runtime secrets from **Infisical** at boot
via the `with-infisical` entrypoint ([ADR-0020](decisions/0020-adopt-infisical-for-runtime-secrets.md)),
using the Infisical machine-identity "secret zero"
(`INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET`) that lives
in the gitignored per-stack host env file `compose/<stack>.env`
(template `.env.prod.example`). 1Password may hold a backup copy of the
machine-identity credential and of the Infisical instance's own encryption key,
but production containers do not read those from 1Password.

Do not run production containers under `op run`; that would make app startup
depend on 1Password availability.

To rotate a runtime app secret: edit it in Infisical and redeploy the affected
stack (`scripts/deploy-stack.sh <stack>`). No compose edit, no GitHub secret
change. This workflow (1Password + `op run`) covers only the **deploy** secrets
above, not runtime app secrets.

## Guardrails

- Do not run `op read` for these values during agent work.
- Do not run `op item get` for secret-bearing items during agent work.
- Do not print `env`, `printenv`, or `echo $ORACLE_SSH_*` / `echo $SENTRY_*`.
- Do not use `gh secret set --body`.
- Do not add a second secret path without updating this file and
  `OPERATIONS.md`.

## References

- 1Password CLI `op run`: https://developer.1password.com/docs/cli/reference/commands/run/
- GitHub Actions secrets: https://docs.github.com/en/actions/reference/security/secrets
- Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings
- Codex AGENTS.md discovery: https://developers.openai.com/codex/guides/agents-md
