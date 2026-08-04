#!/usr/bin/env bash
# check-business-health.sh — business-signal alerter for Example Kitchen production
#
# Why this exists: process-level healthchecks (docker HEALTHCHECK, /healthz)
# are not enough. Lesson #8 from HANDOFF-deployment-2026-05-16.md §7:
#
#   "Intelligence 17 小时 uptime 期间 Clover 401 已经持续了 24+ 小时,
#    但 healthcheck 是 GET /healthz, 不监控业务指标."
#
# This script checks three business signals that historically silently
# broke and sends a single summary email when any of them are red:
#
#   1. audit.sync_runs failure rate in the last N minutes
#   2. audit.service_heartbeats lag per worker subsystem
#      (the 9 subsystems: scheduler / realtime / export / hydration /
#       repair / dq / mart / webhook-inbox / http server)
#   3. Clover 401 count in analytics-api logs in the last N minutes
#
# Designed to run from cron every 15 minutes on the production host.
# Suppresses duplicate emails for SUPPRESS_WINDOW_SEC (default 1 hour)
# when the failing-check fingerprint is the same, to avoid email storms.
#
# Install (on the production host):
#   crontab -e
#   */15 * * * * $HOME/restaurant-ops-platform/scripts/check-business-health.sh >/dev/null 2>&1
#
# Manual checks:
#   ./scripts/check-business-health.sh --dry-run   # print, do not email
#   ./scripts/check-business-health.sh --force     # bypass suppression
#   ./scripts/check-business-health.sh --debug     # print SQL before running
#
# Exit codes:
#   0   no failures, or failures detected and email sent successfully
#   1   hard error (DB unreachable, mail command missing, etc.)
#
# This script is read-only against the OLAP DB; it does not modify any
# data. Safe to run frequently.

set -euo pipefail

# Optional host secrets / overrides (e.g. SLACK_WEBHOOK_URL) — chmod 600,
# gitignored, NOT committed. Sourced BEFORE the defaults below so an explicit
# env var still wins over the file, which wins over the built-in default.
ALERT_ENV_FILE=${ALERT_ENV_FILE:-$HOME/.rop-alert.env}
if [ -f "$ALERT_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ALERT_ENV_FILE"
fi

ALERT_EMAIL=${ALERT_EMAIL:-alerts@example.com}
SYNC_FAILURE_WINDOW_MIN=${SYNC_FAILURE_WINDOW_MIN:-30}
SYNC_FAILURE_THRESHOLD_PCT=${SYNC_FAILURE_THRESHOLD_PCT:-50}
SYNC_MIN_RUNS=${SYNC_MIN_RUNS:-3}
HEARTBEAT_LAG_MAX_MIN=${HEARTBEAT_LAG_MAX_MIN:-5}
CLOVER_LOG_WINDOW_MIN=${CLOVER_LOG_WINDOW_MIN:-60}
CLOVER_401_THRESHOLD=${CLOVER_401_THRESHOLD:-1}
SUPPRESS_WINDOW_SEC=${SUPPRESS_WINDOW_SEC:-3600}
STATE_FILE=${STATE_FILE:-$HOME/.business-health-state}
LOG_FILE=${LOG_FILE:-$HOME/business-health.log}
ANALYTICS_PG_CONTAINER=${ANALYTICS_PG_CONTAINER:-rop-analytics-postgres-analytics-1}
ANALYTICS_PG_DB=${ANALYTICS_PG_DB:-rop_analytics}
ANALYTICS_PG_USER=${ANALYTICS_PG_USER:-postgres}
ANALYTICS_API_CONTAINER=${ANALYTICS_API_CONTAINER:-rop-analytics-analytics-api-1}
CONTAINER_NAME_PREFIX=${CONTAINER_NAME_PREFIX:-rop-}
# Delivery channels. Slack reuses the suite's SLACK_WEBHOOK_URL (same value the
# Mac-Mini heartbeat + CI notifier use); set it in $ALERT_ENV_FILE on the host.
# Both channels fire when configured; set NOTIFY_EMAIL=0 for Slack-only.
SLACK_WEBHOOK_URL=${SLACK_WEBHOOK_URL:-}
NOTIFY_EMAIL=${NOTIFY_EMAIL:-1}

DRY_RUN=0
FORCE=0
DEBUG=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --debug)   DEBUG=1 ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

trap 'log "ERROR: script failed at line $LINENO (exit $?)"' ERR

run_sql() {
  local sql="$1"
  if [ "$DEBUG" -eq 1 ]; then
    log "SQL: $sql"
  fi
  docker exec "$ANALYTICS_PG_CONTAINER" \
    psql -U "$ANALYTICS_PG_USER" -d "$ANALYTICS_PG_DB" -tA -c "$sql" 2>/dev/null
}

# Post a single attachment to the suite Slack webhook. Mirrors the payload shape
# of scripts/heartbeat/heartbeat.py post_slack() so both ops alerters look the
# same in the channel. JSON is encoded by python3 (present on the host) with the
# strings passed via env, so a hostile container/error string is inert data, not
# shell/JSON injection. Returns non-zero on any failure so the caller can fall
# back to email. $1=title $2=body.
post_slack() {
  local title="$1" body="$2" payload code
  # Slack attachment text caps ~3000 chars; trim defensively.
  body=$(printf '%s' "$body" | head -c 2800)
  payload=$(SLACK_T="$title" SLACK_B="$body" python3 -c 'import json,os; print(json.dumps({"text":os.environ["SLACK_T"],"attachments":[{"color":"danger","title":os.environ["SLACK_T"],"text":os.environ["SLACK_B"],"fallback":os.environ["SLACK_T"],"mrkdwn_in":["text"]}]}))') || return 1
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-type: application/json' \
    --data "$payload" "$SLACK_WEBHOOK_URL" 2>/dev/null) || return 1
  [ "$code" = "200" ]
}

# Require at least one working delivery channel (skipped under --dry-run).
if [ "$DRY_RUN" -eq 0 ]; then
  HAVE_CHANNEL=0
  [ -n "${SLACK_WEBHOOK_URL:-}" ] && command -v python3 >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && HAVE_CHANNEL=1
  if [ "$NOTIFY_EMAIL" != "0" ] && [ -n "${ALERT_EMAIL:-}" ] && command -v mail >/dev/null 2>&1; then
    HAVE_CHANNEL=1
  fi
  if [ "$HAVE_CHANNEL" -eq 0 ]; then
    log "ABORT: no delivery channel — set SLACK_WEBHOOK_URL in $ALERT_ENV_FILE (needs python3+curl) or install mailutils + set ALERT_EMAIL."
    exit 1
  fi
fi

FAILURES=()
DETAILS=""

# Check 0: container liveness (the 2026-06-18 KDS crash-loop class).
# Runs FIRST and independently of the analytics DB — docker only — so a down
# kds / inventory / crm / observability container alerts even when the analytics
# stack the DB-backed checks below depend on is itself the thing that is down.
# Inspects every container named ${CONTAINER_NAME_PREFIX}* that has an
# auto-restart policy; this deliberately excludes one-shot migrate sidecars
# (RestartPolicy "no", whose clean Exited(0) must NOT page). Flags any not
# cleanly running: Created / Exited / Restarting, or healthcheck == unhealthy.
if command -v docker >/dev/null 2>&1; then
  down_containers=""
  while IFS= read -r cname; do
    [ -z "$cname" ] && continue
    info=$(docker inspect -f \
      '{{.HostConfig.RestartPolicy.Name}}|{{.State.Status}}|{{.State.Restarting}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}' \
      "$cname" 2>/dev/null) || continue
    IFS='|' read -r rpolicy status restarting health restarts <<< "$info"
    case "$rpolicy" in no|"") continue ;; esac   # one-shot sidecars stay quiet
    if [ "$status" != "running" ] || [ "$restarting" = "true" ] || [ "$health" = "unhealthy" ]; then
      down_containers+="  ${cname}: status=${status} restarting=${restarting} health=${health} restarts=${restarts}
"
    fi
  done < <(docker ps -a --filter "name=${CONTAINER_NAME_PREFIX}" --format '{{.Names}}')

  if [ -n "$down_containers" ]; then
    down_list=$(printf '%s' "$down_containers" | sed 's/^[[:space:]]*//; s/:.*//' | sort | paste -sd, -)
    FAILURES+=("containers_down:${down_list}")
    DETAILS+="=== container liveness (auto-restart services not cleanly running) ===
${down_containers}
"
  fi
else
  log "WARN: docker not available; container-liveness check skipped"
fi

# Checks 1-3 read the analytics OLAP DB. If it is unreachable, record THAT as a
# failure and skip them — do NOT silently abort. Going dark exactly when its own
# DB dies is the failure this alerter exists to catch; run_sql() swallows the
# psql error (2>/dev/null) so the dependent counts would otherwise default to 0
# and report a false "all checks passed". to_regclass() returns NULL (not an
# error) when a relation is missing/invisible, so the cases stay distinct: a
# non-zero psql exit = unreachable/auth, a non-"t" result = schema unreadable.
# (The container check above already ran regardless of DB state.)
ANALYTICS_OK=1
if ! docker inspect "$ANALYTICS_PG_CONTAINER" >/dev/null 2>&1; then
  ANALYTICS_OK=0
  FAILURES+=("analytics_db_down:container_missing")
  DETAILS+="=== analytics OLAP DB unreachable ===
container '${ANALYTICS_PG_CONTAINER}' not present/running; sync / heartbeat / Clover-401 checks skipped.

"
elif ! preflight=$(docker exec "$ANALYTICS_PG_CONTAINER" \
  psql -U "$ANALYTICS_PG_USER" -d "$ANALYTICS_PG_DB" -tAc \
  "SELECT (to_regclass('audit.sync_runs') IS NOT NULL
       AND to_regclass('audit.service_heartbeats') IS NOT NULL);" 2>&1); then
  ANALYTICS_OK=0
  FAILURES+=("analytics_db_down:unreachable")
  DETAILS+="=== analytics OLAP DB unreachable ===
container=${ANALYTICS_PG_CONTAINER} db=${ANALYTICS_PG_DB} user=${ANALYTICS_PG_USER}
psql error: ${preflight}
sync / heartbeat / Clover-401 checks skipped.

"
elif [ "$preflight" != "t" ]; then
  ANALYTICS_OK=0
  FAILURES+=("analytics_db_down:schema_unreadable")
  DETAILS+="=== analytics OLAP DB schema not readable ===
audit schema not readable as user '${ANALYTICS_PG_USER}' (db=${ANALYTICS_PG_DB}); to_regclass probe returned: '${preflight}'
sync / heartbeat / Clover-401 checks skipped.

"
fi

# Defaults so the success-path log line stays safe under `set -u` when the
# DB-backed checks below were skipped.
sync_failed=0
sync_total=0

if [ "$ANALYTICS_OK" -eq 1 ]; then

# Check 1: sync_runs failure rate
sync_stats=$(run_sql "
  SELECT
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
    COUNT(*)::int AS total
  FROM audit.sync_runs
  WHERE created_at > NOW() - INTERVAL '${SYNC_FAILURE_WINDOW_MIN} minutes';
" | head -1)

sync_failed=$(echo "$sync_stats" | cut -d'|' -f1)
sync_total=$(echo "$sync_stats" | cut -d'|' -f2)
sync_failed=${sync_failed:-0}
sync_total=${sync_total:-0}

if [ "$sync_total" -ge "$SYNC_MIN_RUNS" ]; then
  if [ "$sync_total" -gt 0 ]; then
    sync_pct=$(( sync_failed * 100 / sync_total ))
  else
    sync_pct=0
  fi
  if [ "$sync_pct" -ge "$SYNC_FAILURE_THRESHOLD_PCT" ]; then
    FAILURES+=("sync_runs_high_failure_rate:${sync_pct}pct")
    DETAILS+="=== sync_runs failure rate (last ${SYNC_FAILURE_WINDOW_MIN}min) ===
Failed: ${sync_failed} / ${sync_total} (${sync_pct}%)
Threshold: >=${SYNC_FAILURE_THRESHOLD_PCT}%

Recent failures:
"
    DETAILS+=$(run_sql "
      SELECT
        created_at::text,
        job_type,
        merchant_id,
        status,
        COALESCE(error_message, '(no message)')
      FROM audit.sync_runs
      WHERE status = 'failed'
        AND created_at > NOW() - INTERVAL '${SYNC_FAILURE_WINDOW_MIN} minutes'
      ORDER BY created_at DESC
      LIMIT 10;
    " | sed 's/|/  /g')
    DETAILS+="

"
  fi
fi

# Check 2: heartbeat lag per component
stale_heartbeats=$(run_sql "
  SELECT
    component || '|' || EXTRACT(EPOCH FROM (NOW() - last_seen_at))::int
  FROM audit.service_heartbeats
  WHERE last_seen_at < NOW() - INTERVAL '${HEARTBEAT_LAG_MAX_MIN} minutes'
  ORDER BY last_seen_at ASC;
")

if [ -n "$stale_heartbeats" ]; then
  components=$(echo "$stale_heartbeats" | cut -d'|' -f1 | sort -u | tr '\n' ',' | sed 's/,$//')
  FAILURES+=("stale_heartbeats:${components}")
  DETAILS+="=== service_heartbeats lag (threshold >${HEARTBEAT_LAG_MAX_MIN}min) ===
"
  while IFS='|' read -r component lag_sec; do
    [ -z "$component" ] && continue
    lag_min=$(( lag_sec / 60 ))
    DETAILS+="  ${component}: ${lag_min}min behind
"
  done <<< "$stale_heartbeats"
  DETAILS+="
"
fi

# Check 3: Clover 401 in analytics-api logs
if docker inspect "$ANALYTICS_API_CONTAINER" >/dev/null 2>&1; then
  clover_401_count=$(docker logs --since "${CLOVER_LOG_WINDOW_MIN}m" "$ANALYTICS_API_CONTAINER" 2>&1 \
    | grep -ciE '(401|unauthorized).*clover|clover.*(401|unauthorized)' || true)

  if [ "$clover_401_count" -ge "$CLOVER_401_THRESHOLD" ]; then
    FAILURES+=("clover_401:${clover_401_count}")
    DETAILS+="=== Clover 401 in analytics-api logs (last ${CLOVER_LOG_WINDOW_MIN}min) ===
Count: ${clover_401_count} (threshold: >=${CLOVER_401_THRESHOLD})

Recent matches:
"
    DETAILS+=$(docker logs --since "${CLOVER_LOG_WINDOW_MIN}m" "$ANALYTICS_API_CONTAINER" 2>&1 \
      | grep -iE '(401|unauthorized).*clover|clover.*(401|unauthorized)' \
      | tail -5)
    DETAILS+="

"
  fi
else
  log "WARN: analytics-api container '$ANALYTICS_API_CONTAINER' not running; Clover 401 check skipped"
fi

fi  # end ANALYTICS_OK guard (Checks 1-3 depend on the analytics OLAP DB)

# Decide whether to alert
if [ ${#FAILURES[@]} -eq 0 ]; then
  log "OK: all checks passed (sync_runs ${sync_failed}/${sync_total}, no stale heartbeats, clover_401=${clover_401_count:-na})"
  exit 0
fi

# Fingerprint to suppress repeat alerts
fingerprint=$(printf '%s\n' "${FAILURES[@]}" | sort | shasum | cut -d' ' -f1)

if [ "$FORCE" -eq 0 ] && [ -f "$STATE_FILE" ]; then
  last_fp=$(awk -F'|' 'NR==1 {print $1}' "$STATE_FILE" 2>/dev/null || true)
  last_ts=$(awk -F'|' 'NR==1 {print $2}' "$STATE_FILE" 2>/dev/null || true)
  now_ts=$(date -u +%s)

  if [ "$last_fp" = "$fingerprint" ] && [ -n "$last_ts" ]; then
    elapsed=$(( now_ts - last_ts ))
    if [ "$elapsed" -lt "$SUPPRESS_WINDOW_SEC" ]; then
      log "SUPPRESS: same fingerprint as ${elapsed}s ago (window=${SUPPRESS_WINDOW_SEC}s). Failures=[${FAILURES[*]}]"
      exit 0
    fi
  fi
fi

# Compose and send
subject="[restaurant-ops-platform] business health alert: ${FAILURES[*]}"
body="Production business health check failed at $(date -u +'%Y-%m-%dT%H:%M:%SZ').

Host: $(hostname)
Triggered checks: ${FAILURES[*]}

----------------------------------------
${DETAILS}
----------------------------------------

Investigate:
  ssh oracle
  docker logs ${ANALYTICS_API_CONTAINER} --tail 100
  docker exec ${ANALYTICS_PG_CONTAINER} psql -U ${ANALYTICS_PG_USER} -d ${ANALYTICS_PG_DB} \\
    -c \"SELECT component, last_seen_at FROM audit.service_heartbeats ORDER BY last_seen_at DESC;\"

This alert will not re-fire for the same fingerprint within ${SUPPRESS_WINDOW_SEC}s.
To force resend immediately: $0 --force
"

if [ "$DRY_RUN" -eq 1 ]; then
  channels=""
  [ -n "${SLACK_WEBHOOK_URL:-}" ] && channels="slack"
  if [ "$NOTIFY_EMAIL" != "0" ] && [ -n "${ALERT_EMAIL:-}" ]; then
    channels="${channels:+$channels+}email(${ALERT_EMAIL})"
  fi
  log "DRY-RUN: would notify via [${channels:-none}]"
  echo "Subject: ${subject}"
  echo ""
  echo "$body"
  exit 0
fi

# Deliver to every configured channel; the state file (suppression) is written
# if AT LEAST ONE channel succeeded.
sent_any=0

if [ -n "${SLACK_WEBHOOK_URL:-}" ]; then
  if post_slack "🔴 ${subject}" "$body"; then
    sent_any=1
    log "ALERT_SENT_SLACK: fp=${fingerprint} failures=[${FAILURES[*]}]"
  else
    log "ERROR: Slack post failed (fingerprint=${fingerprint})"
  fi
fi

if [ "$NOTIFY_EMAIL" != "0" ] && [ -n "${ALERT_EMAIL:-}" ] && command -v mail >/dev/null 2>&1; then
  if echo "$body" | mail -s "$subject" "$ALERT_EMAIL"; then
    sent_any=1
    log "ALERT_SENT_EMAIL: to=${ALERT_EMAIL} fp=${fingerprint} failures=[${FAILURES[*]}]"
  else
    log "ERROR: mail command failed (fingerprint=${fingerprint})"
  fi
fi

if [ "$sent_any" -eq 1 ]; then
  echo "${fingerprint}|$(date -u +%s)" > "$STATE_FILE"
else
  log "ERROR: no channel delivered the alert (fingerprint=${fingerprint})"
  exit 1
fi
