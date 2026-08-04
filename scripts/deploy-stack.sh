#!/usr/bin/env bash
# Deploy one Example Kitchen stack on the production host via plain docker compose.
#
# Invoked over SSH by .github/workflows/build-images.yml after an image is pushed
# to GHCR (this replaced the old Dokploy redeploy webhook — Dokploy + Swarm were
# removed). Also safe to run by hand on the host:
#     bash ~/restaurant-ops-platform/scripts/deploy-stack.sh kds
#
# It git-syncs the host checkout to origin/main (so the compose file and this
# script match main), then `docker compose pull` + `up -d` for the named stack,
# using the per-stack host env file if present (compose/<stack>.env —
# gitignored real secrets/bootstrap; see .env.prod.example).
set -euo pipefail

stack="${1:?usage: deploy-stack.sh <stack>  (kds|analytics|backoffice|inventory|crm|notifications|crew|order|legal|marketing)}"

cd "$(dirname "$0")/.."   # repo root (scripts/..)

# Serialize concurrent deploys on this host. The build matrix can fire two
# deploys at once (e.g. kds-api + kds-web both target the kds stack), and neither
# `git reset` on a shared checkout nor `docker compose up` on a shared project is
# safe run concurrently. A single global lock keeps deploys serial; they're short
# so the wait is negligible.
exec 9>/tmp/rop-deploy.lock
flock 9

# Sync the checkout so the compose file + this script match origin/main. Hard
# reset is robust against host drift; gitignored *.env files and other untracked
# files survive it. Best-effort: if the host can't fetch (creds/network), deploy
# the current checkout rather than blocking the rollout, but say so loudly.
if git fetch --quiet origin main 2>/dev/null; then
  git reset --quiet --hard origin/main
else
  echo "::warning::deploy-stack: git fetch failed — deploying the current checkout as-is" >&2
fi

compose="compose/${stack}.yml"
[ -f "$compose" ] || { echo "deploy-stack: no compose file '$compose'" >&2; exit 1; }

args=(-f "$compose")
envf="compose/${stack}.env"
if [ -f "$envf" ]; then
  args+=(--env-file "$envf")
else
  echo "deploy-stack: note — no $envf (stack needs no host env, or it is unconfigured)"
fi

echo "deploy-stack: deploying '$stack' ($compose)"
docker compose "${args[@]}" pull
# Gate the deploy on readiness. `--wait` blocks until every service is running /
# healthy per its compose healthcheck and exits non-zero if one crash-loops or
# fails its healthcheck within the timeout; `set -e` then aborts and the failure
# propagates to the SSH caller in build-images.yml (loud + Slack-alerted). This
# turns a crash-looping release — e.g. the 2026-06-18 AI_TOKEN_ENCRYPTION_KEY
# outage, where kds-api never bound so /api/health never went healthy — from a
# silent "deployed" into a failed deploy. One-shot migrate sidecars
# (restart: "no", exit 0) are treated by --wait as completed, not failed (the host
# runs docker compose v5). Bump DEPLOY_WAIT_TIMEOUT for an unusually heavy first
# migrate if ever needed.
docker compose "${args[@]}" up -d --remove-orphans --wait --wait-timeout "${DEPLOY_WAIT_TIMEOUT:-120}"
echo "deploy-stack: '$stack' up and healthy"

# Reclaim the image the just-pulled :main tag displaced. Compose pins :main
# (pull_policy: always), so every deploy moves :main to the freshly-built image
# and orphans the previous one as a dangling <none> image. Nothing else does
# host-side image GC (OPERATIONS §5.5 covers only the observability volumes), so
# left alone these accumulate until the Oracle host's disk fills.
#
#   `-f`  = dangling ONLY — never `-af`. Mirrors the runner-side prune in
#           build-images.yml: keeps base images (node:/nginx:) and every current
#           :main tag, drops only the untagged orphans that are the actual junk.
#   NOT `volume prune` — unlike the runner, host volumes hold real DB data.
#
# Runs only after a successful `up -d`; `|| true` so a prune hiccup never fails
# an otherwise-good deploy. Rollback is unaffected — §4.7 re-pulls :<sha> from
# GHCR, so the host never needs to retain old images locally.
echo "deploy-stack: pruning dangling images (host-side reclaim)"
docker image prune -f || true
