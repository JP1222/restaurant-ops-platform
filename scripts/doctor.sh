#!/usr/bin/env bash
# scripts/doctor.sh — quick local-dev environment diagnosis.
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || { echo "✗ cannot cd to repo root ($ROOT_DIR)"; exit 1; }

echo "restaurant-ops-platform local-dev doctor"
echo "──────────────────────────────"

if docker info >/dev/null 2>&1; then
  echo "✓ Docker daemon running"
else
  echo "✗ Docker not running — start Docker Desktop"
fi

echo "Backing services:"
docker compose -f docker-compose.dev.yml ps --format '  {{.Service}}: {{.Status}}' 2>/dev/null | grep . \
  || echo "  (none up — run: make dev-up)"

echo "Ports:"
for p in 3000 3001 4000 4100 3100 5432 5433 5434 6379; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  :$p in use"
  else
    echo "  :$p free"
  fi
done

echo "Workspace libraries (built?):"
for d in contracts auth db-kds db-auth db-inventory; do
  if compgen -G "packages/$d/dist/*" >/dev/null 2>&1 || compgen -G "packages/$d/generated/*" >/dev/null 2>&1; then
    echo "  ✓ packages/$d"
  else
    echo "  ✗ packages/$d not built — run: make dev-up"
  fi
done

printf "Secrets backend: "
if [ "${SECRETS_BACKEND:-}" = "infisical" ] || [ -n "${INFISICAL_TOKEN:-}${INFISICAL_MACHINE_CLIENT_ID:-}" ]; then
  echo "infisical"
  command -v infisical >/dev/null 2>&1 && echo "  ✓ infisical CLI present" || echo "  ✗ infisical CLI missing"
else
  echo "local (scripts/dev-defaults.sh non-secret defaults)"
fi
