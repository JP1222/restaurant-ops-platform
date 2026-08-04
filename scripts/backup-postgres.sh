#!/usr/bin/env bash
# backup-postgres.sh — nightly logical backup of the Example Kitchen Postgres DBs
# to Cloudflare R2, with client-side encryption and Prometheus status metrics.
#
# Why this exists: OPERATIONS.md §8.1 long listed every `postgres-*` volume as
# "❌ no scheduled backup". This closes that gap. It is the write-side companion
# to the read-only check-business-health.sh and follows the same conventions
# (host cron, --dry-run/--force/--debug, docker exec psql, single log file).
#
# What it does, per enabled database:
#   1. pg_dump -Fc (custom format, compressed) INSIDE the db container, so the
#      pg_dump version always matches the server (postgres:16-alpine).
#   2. Optionally `age`-encrypt the dump client-side (default ON — crm holds
#      customer PII; we never upload plaintext). Decryption key lives in
#      1Password, NOT on this host (see OPERATIONS.md §8).
#   3. Upload to R2 via rclone, then prune objects older than the retention.
#   4. Write a Prometheus textfile metric so Grafana can alert when a backup
#      goes stale (the dead-man's-switch).
#
# Behavior knobs come from the AppSetting registry (packages/contracts/
# src/settings.ts), read live from postgres-kds with the same DB→env→default
# precedence the Node reader uses. Credentials stay in env (ADR-0016 §4).
#
# Install (on the production host):
#   crontab -e
#   # nightly at 03:00 UTC, with the secrets the job needs:
#   0 3 * * * BACKUP_AGE_RECIPIENT=age1... RCLONE_REMOTE=r2 BACKUP_R2_BUCKET=rop-backups \
#     $HOME/restaurant-ops-platform/scripts/backup-postgres.sh >/dev/null 2>&1
#   (cleaner: put those exports in ~/.env.backup and `source` it in a wrapper.)
#
# Manual use:
#   ./scripts/backup-postgres.sh --dry-run   # print actions, dump/encrypt/upload nothing
#   ./scripts/backup-postgres.sh --force     # run even if backup.enabled=false
#   ./scripts/backup-postgres.sh --debug     # print the SQL used to read settings
#
# Exit codes:
#   0   all enabled DBs backed up (or backup disabled and not --force'd)
#   1   hard error (missing dependency/credential) or one or more DBs failed
#
# Requires on the host: docker, rclone, and (when encrypting) age.

set -euo pipefail

# ── Database topology (override only if container/db names change) ────────────
PG_USER=${PG_USER:-postgres}
KDS_PG_CONTAINER=${KDS_PG_CONTAINER:-rop-kds-postgres-kds-1}
KDS_PG_DB=${KDS_PG_DB:-rop_kds}
ANALYTICS_PG_CONTAINER=${ANALYTICS_PG_CONTAINER:-rop-analytics-postgres-analytics-1}
ANALYTICS_PG_DB=${ANALYTICS_PG_DB:-rop_analytics}
INVENTORY_PG_CONTAINER=${INVENTORY_PG_CONTAINER:-rop-inventory-postgres-inventory-1}
INVENTORY_PG_DB=${INVENTORY_PG_DB:-rop_inventory}
CRM_PG_CONTAINER=${CRM_PG_CONTAINER:-rop-crm-postgres-crm-1}
CRM_PG_DB=${CRM_PG_DB:-rop_crm}

# AppSetting lives in postgres-kds (ADR-0016). Single-merchant scope for now.
MERCHANT_ID=${MERCHANT_ID:-default-merchant}

# ── Destination + crypto (secrets — supplied via env, never AppSetting) ───────
RCLONE_REMOTE=${RCLONE_REMOTE:-r2}            # name of the configured rclone remote
BACKUP_R2_BUCKET=${BACKUP_R2_BUCKET:-}        # e.g. rop-backups
BACKUP_AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT:-} # age public key; required iff encrypt

# ── Defaults that mirror the AppSetting registry (used when no DB row/env) ────
DEFAULT_ENABLED=${BACKUP_ENABLED:-true}
DEFAULT_DATABASES=${BACKUP_DATABASES:-kds,analytics,inventory,crm}
DEFAULT_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
DEFAULT_ENCRYPT=${BACKUP_ENCRYPT:-true}

# ── Local paths ──────────────────────────────────────────────────────────────
LOG_FILE=${LOG_FILE:-$HOME/backup-postgres.log}
# node-exporter textfile collector dir — must match the bind mount added to the
# node-exporter service in docker-compose.observability.yml (repo-relative
# ./observability/textfile, i.e. ~/restaurant-ops-platform/observability/textfile on the host).
TEXTFILE_DIR=${TEXTFILE_DIR:-$HOME/restaurant-ops-platform/observability/textfile}
METRIC_FILE="$TEXTFILE_DIR/backup.prom"

DRY_RUN=0
FORCE=0
DEBUG=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --debug)   DEBUG=1 ;;
    -h|--help) sed -n '1,60p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}
trap 'log "ERROR: script failed at line $LINENO (exit $?)"' ERR

is_true() { case "${1,,}" in true|1|yes|on) return 0 ;; *) return 1 ;; esac }

# Read one AppSetting value from postgres-kds. Echoes the JSON-stored scalar
# (booleans/numbers come back bare, e.g. `true` / `30`); empty when no row or
# the DB is unreachable, so the caller falls back to env/default.
read_app_setting() {
  local key="$1" sql
  sql="SELECT value FROM app_setting WHERE key = '$key' AND \"merchantId\" = '$MERCHANT_ID' LIMIT 1;"
  [ "$DEBUG" -eq 1 ] && log "SQL: $sql"
  docker exec "$KDS_PG_CONTAINER" \
    psql -U "$PG_USER" -d "$KDS_PG_DB" -tA -c "$sql" 2>/dev/null || true
}

# DB → env → default for a scalar setting. $1=key $2=env-fallback-var $3=default
get_setting() {
  local key="$1" envvar="$2" default="$3" dbval
  dbval="$(read_app_setting "$key" | head -1)"
  if [ -n "$dbval" ]; then echo "$dbval"; return; fi
  if [ -n "$envvar" ] && [ -n "${!envvar:-}" ]; then echo "${!envvar}"; return; fi
  echo "$default"
}

# backup.databases is the one array key (no registry envVar): DB JSON array →
# BACKUP_DATABASES env (comma list) → default. Emits space-separated tokens.
resolve_databases() {
  local dbval
  dbval="$(read_app_setting 'backup.databases' | head -1)"
  if [ -n "$dbval" ]; then echo "$dbval" | tr -d '[]" ' | tr ',' ' '; return; fi
  echo "$DEFAULT_DATABASES" | tr ',' ' '
}

# Previous success timestamp for a db, read back from the metric file, so a db
# that FAILS this run keeps ageing toward the alert instead of vanishing.
prev_success_ts() {
  [ -f "$METRIC_FILE" ] || { echo ""; return; }
  grep -E "^rop_backup_last_success_timestamp_seconds\{database=\"$1\"\}" "$METRIC_FILE" 2>/dev/null \
    | awk '{print $2}' | head -1
}

map_container() { case "$1" in
  kds) echo "$KDS_PG_CONTAINER";; analytics) echo "$ANALYTICS_PG_CONTAINER";;
  inventory) echo "$INVENTORY_PG_CONTAINER";; crm) echo "$CRM_PG_CONTAINER";; *) echo "";; esac }
map_dbname() { case "$1" in
  kds) echo "$KDS_PG_DB";; analytics) echo "$ANALYTICS_PG_DB";;
  inventory) echo "$INVENTORY_PG_DB";; crm) echo "$CRM_PG_DB";; *) echo "";; esac }

# Per-run metric accumulators (indexed arrays; bash 3.2-safe, no assoc arrays).
METRIC_LINES=()
record_metric() { METRIC_LINES+=("$1"); }

# Print one metric family: its HELP/TYPE header, then every recorded sample
# whose line starts with that exact metric name. Grouping by family (not by db)
# keeps each family's samples contiguous, as the Prometheus text format requires.
emit_one_family() {
  local name="$1" help="$2" line
  echo "# HELP $name $help"
  echo "# TYPE $name gauge"
  for line in ${METRIC_LINES[@]+"${METRIC_LINES[@]}"}; do
    case "$line" in "$name "*|"$name{"*) echo "$line" ;; esac
  done
}

emit_metrics() {
  if ! mkdir -p "$TEXTFILE_DIR" 2>/dev/null; then
    log "WARN: cannot write metrics to $TEXTFILE_DIR (textfile collector dir); skipping metric emit"
    return 0
  fi
  local tmp="$METRIC_FILE.$$.tmp"
  {
    emit_one_family rop_backup_last_run_timestamp_seconds "Unix time of the last backup attempt."
    emit_one_family rop_backup_last_success_timestamp_seconds "Unix time of the last successful backup, per database."
    emit_one_family rop_backup_last_run_success "Whether the most recent run succeeded (1) or failed (0), per database."
    emit_one_family rop_backup_last_size_bytes "Size in bytes of the last uploaded dump, per database."
    emit_one_family rop_backup_last_duration_seconds "Wall-clock duration of the last backup, per database."
  } > "$tmp"
  mv -f "$tmp" "$METRIC_FILE"  # atomic: collector never sees a partial file
}

# Dump → (encrypt) → upload → prune for one db. Returns 1 on any failure.
backup_one_db() {
  local db="$1" container db_name start ts fname localtmp size dur
  container="$(map_container "$db")"; db_name="$(map_dbname "$db")"
  if [ -z "$container" ]; then log "FAIL [$db]: unknown database id"; return 1; fi
  if ! docker inspect "$container" >/dev/null 2>&1; then
    log "FAIL [$db]: container '$container' not running"; return 1
  fi
  start=$(date +%s); ts=$(date -u +%Y%m%dT%H%M%SZ); fname="${db}/${db}-${ts}.dump"

  if [ "$DRY_RUN" -eq 1 ]; then
    local dest="$fname"; is_true "$ENCRYPT" && dest="$fname.age"
    log "DRY-RUN [$db]: pg_dump $container:$db_name → ${RCLONE_REMOTE}:${BACKUP_R2_BUCKET}/${dest}, then prune > ${RETENTION_DAYS}d"
    return 0
  fi

  localtmp="$(mktemp "${TMPDIR:-/tmp}/yr-backup-${db}.XXXXXX")"
  if ! docker exec "$container" pg_dump -U "$PG_USER" -Fc --no-owner --no-acl "$db_name" > "$localtmp" 2>>"$LOG_FILE"; then
    log "FAIL [$db]: pg_dump failed"; rm -f "$localtmp"; return 1
  fi
  if is_true "$ENCRYPT"; then
    if ! age -r "$BACKUP_AGE_RECIPIENT" -o "$localtmp.age" "$localtmp" 2>>"$LOG_FILE"; then
      log "FAIL [$db]: age encryption failed"; rm -f "$localtmp" "$localtmp.age"; return 1
    fi
    rm -f "$localtmp"; localtmp="$localtmp.age"; fname="$fname.age"
  fi
  size=$(wc -c < "$localtmp" | tr -d ' ')
  if ! rclone copyto "$localtmp" "${RCLONE_REMOTE}:${BACKUP_R2_BUCKET}/${fname}" 2>>"$LOG_FILE"; then
    log "FAIL [$db]: rclone upload failed"; rm -f "$localtmp"; return 1
  fi
  rm -f "$localtmp"
  # Prune only AFTER the new dump is safely up, so a failed run never deletes
  # the last good backup.
  rclone delete "${RCLONE_REMOTE}:${BACKUP_R2_BUCKET}/${db}/" --min-age "${RETENTION_DAYS}d" 2>>"$LOG_FILE" || \
    log "WARN [$db]: prune of objects older than ${RETENTION_DAYS}d failed (non-fatal)"
  dur=$(( $(date +%s) - start ))
  log "OK   [$db]: uploaded $fname (${size} bytes, ${dur}s)"
  record_metric "rop_backup_last_success_timestamp_seconds{database=\"$db\"} $NOW"
  record_metric "rop_backup_last_run_success{database=\"$db\"} 1"
  record_metric "rop_backup_last_size_bytes{database=\"$db\"} $size"
  record_metric "rop_backup_last_duration_seconds{database=\"$db\"} $dur"
  return 0
}

# ── Resolve behavior from AppSetting ─────────────────────────────────────────
NOW=$(date +%s)
ENABLED="$(get_setting 'backup.enabled' 'BACKUP_ENABLED' "$DEFAULT_ENABLED")"
ENCRYPT="$(get_setting 'backup.encrypt' 'BACKUP_ENCRYPT' "$DEFAULT_ENCRYPT")"
RETENTION_DAYS="$(get_setting 'backup.retention_days' 'BACKUP_RETENTION_DAYS' "$DEFAULT_RETENTION_DAYS")"
DATABASES="$(resolve_databases)"

if ! is_true "$ENABLED" && [ "$FORCE" -eq 0 ]; then
  log "backup.enabled=false — skipping (use --force to override). DBs would be: $DATABASES"
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { log "ABORT: docker not found"; exit 1; }
if [ "$DRY_RUN" -eq 0 ]; then
  command -v rclone >/dev/null 2>&1 || { log "ABORT: rclone not found (install + configure the '${RCLONE_REMOTE}' R2 remote)"; exit 1; }
  [ -n "$BACKUP_R2_BUCKET" ] || { log "ABORT: BACKUP_R2_BUCKET is empty"; exit 1; }
  if is_true "$ENCRYPT"; then
    command -v age >/dev/null 2>&1 || { log "ABORT: backup.encrypt=true but 'age' not found"; exit 1; }
    # The safety invariant: never silently fall back to plaintext for PII.
    [ -n "$BACKUP_AGE_RECIPIENT" ] || { log "ABORT: backup.encrypt=true but BACKUP_AGE_RECIPIENT is empty — refusing to upload plaintext"; exit 1; }
  fi
fi

log "starting backup — encrypt=$ENCRYPT retention=${RETENTION_DAYS}d databases=[$DATABASES]$([ "$DRY_RUN" -eq 1 ] && printf ' (dry-run)')"

rc=0
for db in $DATABASES; do
  if ! backup_one_db "$db"; then
    rc=1
    # Keep the previous success timestamp ageing so the dead-man's-switch fires.
    pts="$(prev_success_ts "$db")"
    [ -n "$pts" ] && record_metric "rop_backup_last_success_timestamp_seconds{database=\"$db\"} $pts"
    record_metric "rop_backup_last_run_success{database=\"$db\"} 0"
  fi
done

record_metric "rop_backup_last_run_timestamp_seconds $NOW"
[ "$DRY_RUN" -eq 0 ] && emit_metrics

if [ "$rc" -eq 0 ]; then
  log "backup complete — all enabled databases OK"
else
  log "backup FINISHED WITH FAILURES — see above; metrics updated for Grafana alert"
fi
exit "$rc"
