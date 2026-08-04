#!/usr/bin/env bash
# Wake-and-wait for a reachable Docker daemon on the self-hosted mac runners.
#
# Why this exists (CI-resilience, 2026-06-03): the Docker-dependent CI jobs
# (`pnpm test:integration` in the `ci` job, and the raw `docker run` in
# `migration-smoke`) intermittently red-failed because the runner's Docker
# engine was unreachable when the job started — e.g. shortly after an
# OrbStack / Mac restart. Re-running passed, so the tests were fine; CI just
# wasn't resilient to a briefly-unavailable engine. This step makes the engine
# reachability a precondition of those jobs instead of a coin-flip.
#
# Two things this does that a naive "retry `docker info` for 60s" loop does NOT:
#
#   1. EXPLICITLY STARTS the engine, choosing the launcher by the ACTIVE docker
#      context (`colima start` / `orb start` / `open -a Docker`) rather than by
#      "whichever binary is installed" — `orb` stays installed for rollback after
#      the 2026-06-03 OrbStack->colima migration, so launcher-by-presence would
#      wake the WRONG engine (OrbStack) while the CLI context points at colima.
#      Verified live on mac-mini-1: from a FULLY-STOPPED engine a bare
#      `docker info` / `docker ps` fails fast in ~0.03s and does NOT launch it;
#      only the explicit start command does. A poll-only loop would spin until
#      timeout against that state.
#
#   2. FAILS FAST AND LEGIBLY on a permanent outage. If the host is out of disk
#      the engine can never start (`orb start` panics with "no space left on
#      device"). We detect that and exit immediately with `df -h`, instead of
#      letting the job burn its whole `timeout-minutes` (the migration-smoke
#      ~10-min-timeout symptom). A red here then says "fix the runner", not
#      "flaky test".
#
# The probe is `docker info` — the same signal scripts/doctor.sh and
# test/containers/docker.ts use, so "is Docker up?" means one thing repo-wide.
#
# Tunables (env): WAIT_FOR_DOCKER_TIMEOUT (total budget, default 90s),
# WAIT_FOR_DOCKER_INTERVAL (seconds between polls, default 3s).
set -euo pipefail

TIMEOUT="${WAIT_FOR_DOCKER_TIMEOUT:-90}"
INTERVAL="${WAIT_FOR_DOCKER_INTERVAL:-3}"

log() { echo "[wait-for-docker] $*"; }

# Bound each probe so a hung socket can't eat the whole budget. macOS ships
# neither GNU `timeout` nor `gtimeout` by default, so fall back to a plain call
# (empirically `docker info` returns promptly against OrbStack/Docker Desktop,
# and the job's `timeout-minutes` is the ultimate backstop).
probe() {
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 15 docker info >/dev/null 2>&1
  elif command -v timeout >/dev/null 2>&1; then
    timeout 15 docker info >/dev/null 2>&1
  else
    docker info >/dev/null 2>&1
  fi
}

# Fast path — the common case is the engine is already up.
if probe; then
  log "Docker already reachable."
  exit 0
fi

log "Docker not reachable — attempting to start the engine."

# Pick the launcher for the ACTIVE engine, not just "whichever is installed".
# `docker context show` reads local config (not the daemon), so it works even
# while the engine is down. Post OrbStack->colima migration `orb` stays installed
# for rollback, so launcher-by-presence would start the wrong engine.
ctx="$(docker context show 2>/dev/null || echo unknown)"
log "active docker context: ${ctx}"

start_out=""
if [ "$ctx" = "colima" ] && command -v colima >/dev/null 2>&1; then
  log "colima is the active engine — running 'colima start'."
  start_out="$(colima start 2>&1 || true)"
  [ -n "$start_out" ] && printf '%s\n' "$start_out" | sed 's/^/  [colima start] /'
elif command -v orb >/dev/null 2>&1; then
  log "OrbStack detected — running 'orb start'."
  start_out="$(orb start 2>&1 || true)"
  [ -n "$start_out" ] && printf '%s\n' "$start_out" | sed 's/^/  [orb start] /'
elif [ -d "/Applications/Docker.app" ]; then
  log "Docker Desktop detected — running 'open -a Docker'."
  start_out="$(open -a Docker 2>&1 || true)"
  [ -n "$start_out" ] && printf '%s\n' "$start_out" | sed 's/^/  [open Docker] /'
else
  log "No known engine launcher (colima / orb / Docker.app) found — polling in case a 'docker' call auto-starts it."
fi

# Permanent-failure short-circuit. A disk-full host can NEVER start the engine,
# so don't waste the timeout budget — bail now with the actionable signal.
if printf '%s' "$start_out" | grep -qi "no space left on device"; then
  log "ENGINE CANNOT START: the runner is out of disk space."
  df -h / 2>&1 | sed 's/^/  [df -h /] /' || true
  log "This is a host problem, not a flaky test. Free space on the runner, then re-run."
  exit 1
fi

# Bounded poll while the engine finishes coming up.
deadline=$(( SECONDS + TIMEOUT ))
attempt=0
while [ "$SECONDS" -lt "$deadline" ]; do
  attempt=$(( attempt + 1 ))
  if probe; then
    log "Docker reachable after ${attempt} attempt(s) (~${SECONDS}s)."
    exit 0
  fi
  log "attempt ${attempt}: not reachable yet — sleeping ${INTERVAL}s"
  sleep "$INTERVAL"
done

# Timed out — emit diagnostics so the red is self-explaining, then fail.
log "TIMED OUT after ${TIMEOUT}s waiting for Docker to become reachable."
command -v colima >/dev/null 2>&1 && colima status 2>&1 | sed 's/^/  [colima status] /' || true
command -v orb >/dev/null 2>&1 && orb status 2>&1 | sed 's/^/  [orb status] /' || true
df -h / 2>&1 | sed 's/^/  [df -h /] /' || true
docker info 2>&1 | tail -5 | sed 's/^/  [docker info] /' || true
log "The engine never came up. Check the Docker daemon and disk on this runner."
exit 1
