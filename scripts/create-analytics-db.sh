#!/usr/bin/env bash
# scripts/create-analytics-db.sh — idempotently ensure the analytics database exists.
#
# analytics-api runs its raw-SQL migrations on boot but never CREATE DATABASEs.
# docker-compose.dev.yml now provisions a dedicated `postgres-analytics` service
# whose POSTGRES_DB already creates this database — this script is a
# belt-and-suspenders guard so the bootstrap also converges on a hand-rolled or
# single-instance Postgres. `SELECT 1 ... || CREATE` is the idempotent core.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT_DIR/docker-compose.dev.yml")
DB="${ANALYTICS_DB_NAME:-rop_analytics}"
SVC="${ANALYTICS_PG_SERVICE:-postgres-analytics}"

exists="$("${COMPOSE[@]}" exec -T "$SVC" \
  psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB}'" 2>/dev/null || echo "")"

if [ "$exists" = "1" ]; then
  echo "  database ${DB} already exists"
else
  "${COMPOSE[@]}" exec -T "$SVC" psql -U postgres -c "CREATE DATABASE ${DB}"
  echo "  created database ${DB}"
fi
