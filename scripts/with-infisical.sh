#!/bin/sh
# scripts/with-infisical.sh — resilient Infisical secret-injection entrypoint.
#
# If an Infisical credential is present in the environment, fetch this service's
# secrets from Infisical and inject them as environment variables into the child
# process (the CLI's `run` never writes a .env to disk). If no credential is
# present — or the CLI is unavailable / login fails — run the command UNCHANGED,
# so a container behaves identically with or without Infisical wired.
#
# This is what makes the migration safe to roll out one service at a time and
# trivially reversible: a Dockerfile using this entrypoint with NO Infisical env
# set is byte-for-byte equivalent to running the bare command.
#
# Credentials (set in each stack's host env file; absent everywhere else):
#   INFISICAL_TOKEN                          a service token (st....), OR
#   INFISICAL_MACHINE_CLIENT_ID / _SECRET    a machine identity (Universal Auth)
# Config (sensible defaults baked in):
#   INFISICAL_API_URL     default https://app.infisical.com
#   INFISICAL_PROJECT_ID  default the restaurant-ops-platform project
#   INFISICAL_SECRET_ENV  default prod
#   INFISICAL_SECRET_PATH default /
#
# See docs/plan/infisical-migration.md and docs/decisions/0020-adopt-infisical-for-runtime-secrets.md.
set -eu

DOMAIN="${INFISICAL_API_URL:-https://app.infisical.com}"
PROJ="${INFISICAL_PROJECT_ID:-00000000-0000-0000-0000-000000000000}"
ENVF="${INFISICAL_SECRET_ENV:-prod}"
SPATH="${INFISICAL_SECRET_PATH:-/}"
TOKEN="${INFISICAL_TOKEN:-}"

# Machine-identity → exchange for a short-lived token when no raw token is given.
if [ -z "$TOKEN" ] && [ -n "${INFISICAL_MACHINE_CLIENT_ID:-}" ] && [ -n "${INFISICAL_MACHINE_CLIENT_SECRET:-}" ]; then
  if command -v infisical >/dev/null 2>&1; then
    TOKEN="$(infisical login --method=universal-auth \
      --client-id="$INFISICAL_MACHINE_CLIENT_ID" \
      --client-secret="$INFISICAL_MACHINE_CLIENT_SECRET" \
      --domain="$DOMAIN" --plain --silent 2>/dev/null || true)"
  fi
fi

if [ -n "$TOKEN" ] && command -v infisical >/dev/null 2>&1; then
  echo "[with-infisical] injecting secrets from Infisical (env=$ENVF path=$SPATH)"
  exec infisical run --token="$TOKEN" --domain="$DOMAIN" \
    --projectId="$PROJ" --env="$ENVF" --path="$SPATH" -- "$@"
fi

if [ -n "${INFISICAL_TOKEN:-}${INFISICAL_MACHINE_CLIENT_ID:-}" ]; then
  echo "[with-infisical] WARN: Infisical credential set but injection unavailable (CLI missing or login failed); running without injection" >&2
fi
exec "$@"
