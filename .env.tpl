# 1Password reference template for `op run --env-file=.env.tpl -- <agent>`.
#
# Values below are op:// URIs — the 1Password CLI resolves them at process
# start and injects the real secrets as environment variables into the child
# process (Claude Code, Codex CLI, shell scripts, etc.). Real secret values
# never appear in this file, so it is safe to commit. Touch ID via
# 1Password.app handles local authentication.
#
# Launch an agent with secrets injected:
#   cd ~/Desktop/restaurant-ops-platform
#   op run --env-file=.env.tpl -- claude
#   op run --env-file=.env.tpl -- codex
#
# can be used in tool calls (e.g. curl headers) without re-reading from op,
# which would expose the value through tool stdout.
#
# Source vault: Example Kitchen DevOps
# Source item:  Example Kitchen Dokploy

# Dokploy control plane

# Per-compose IDs (Dokploy tRPC compose.update / compose.one)

# Per-compose deploy webhook URLs (POST to redeploy that stack)

# Sentry SaaS — sourcemap upload + release tagging from GHA build job.
# DSN values themselves live in Dokploy compose env (runtime use); only the
# CI-time auth token + org slug are mirrored to GitHub Actions secrets via
# scripts/sync-github-secrets-from-agent-env.sh. See ADR-0014 + Phase 5b plan.
SENTRY_AUTH_TOKEN=op://Example Kitchen DevOps/Example Kitchen Dokploy/sentry_auth_token
SENTRY_ORG=op://Example Kitchen DevOps/Example Kitchen Dokploy/sentry_org
