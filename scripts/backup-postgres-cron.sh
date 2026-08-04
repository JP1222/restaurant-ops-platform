#!/usr/bin/env bash
# backup-postgres-cron.sh — cron entrypoint for the nightly Postgres→R2 backup.
#
# Why a wrapper: backup-postgres.sh needs its R2 + age secrets injected from
# Infisical (env=prod, path=/backup). That requires (a) bash — process
# substitution below — and (b) the Infisical machine identity, neither of which
# a bare crontab line provides cleanly. This sources ONLY the two
# machine-identity vars from an existing stack env file (they are shared across
# stacks), points with-infisical at /backup, and runs the backup. Any args
# (e.g. --dry-run) pass straight through.
#
# Install (host crontab, 03:00 UTC nightly):
#   0 3 * * * $HOME/restaurant-ops-platform/scripts/backup-postgres-cron.sh >> $HOME/backup-postgres.log 2>&1
#
# Manual: ./scripts/backup-postgres-cron.sh --dry-run
set -euo pipefail
cd "$(dirname "$0")/.."  # repo root

# Machine identity (secret-zero) — the same Universal Auth identity every stack
# uses; borrow it from kds.env. grep-then-source so we pull ONLY these two keys,
# never the rest of that file's secrets.
ID_ENV="${BACKUP_INFISICAL_ID_ENV:-compose/kds.env}"
if [ ! -f "$ID_ENV" ]; then
  echo "[backup-cron] ABORT: machine-identity env file not found: $ID_ENV" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090  # dynamic source of a grep-filtered subset; nothing static to follow
. <(grep -E '^INFISICAL_MACHINE_CLIENT_(ID|SECRET)=' "$ID_ENV")
set +a

export INFISICAL_SECRET_PATH=/backup
exec bash ./scripts/with-infisical.sh bash ./scripts/backup-postgres.sh "$@"
