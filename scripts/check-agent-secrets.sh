#!/usr/bin/env sh
set -eu

# Deploy now SSHes to the host and runs docker compose (see ADR: Dokploy/Swarm
# removed). The old DOKPLOY_API_KEY / *_COMPOSE_ID / *_WEBHOOK_* set is retired.
required="
ORACLE_SSH_KEY
ORACLE_SSH_HOST
"

missing=0
for name in $required; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "missing $name"
    missing=1
  else
    echo "ok $name"
  fi
done

exit "$missing"
