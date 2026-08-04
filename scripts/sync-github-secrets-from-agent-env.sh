#!/usr/bin/env sh
set -eu

repo="${GITHUB_REPOSITORY:-example-org/restaurant-ops-platform}"

# Deploy now SSHes to the host and runs docker compose (see ADR: Dokploy/Swarm
# removed). ORACLE_SSH_KEY/HOST replace the old DOKPLOY_* set; Sentry stays.
required="
ORACLE_SSH_KEY
ORACLE_SSH_HOST
SENTRY_AUTH_TOKEN
SENTRY_ORG
"

missing=0
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "missing $name"
    missing=1
    continue
  fi

  printf '%s' "$value" | gh secret set "$name" --repo "$repo" >/dev/null
  echo "synced $name"
done

exit "$missing"
