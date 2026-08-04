#!/usr/bin/env bash
# scripts/with-secrets.sh — LOCAL-DEV secrets front door.
# (The container/prod entrypoint is scripts/with-infisical.sh — Infisical
# secrets migration. This is its host/local-dev sibling; the two are
# complementary, not duplicative.)
#
# Injects the env local commands need, then execs the command. Backends:
#   local      (DEFAULT) — source committed non-secret scripts/dev-defaults.sh,
#                          then load optional gitignored .env.local as DATA
#                          (parsed KEY=VALUE, never executed). Zero setup.
#   infisical  (opt-in)  — `infisical run --env=$ENV --path=/ -- <cmd>`.
#
# Backend = SECRETS_BACKEND if set; else 'infisical' when this repo has
# .infisical.json AND either (a) an INFISICAL_* env credential is present (CI /
# machine identity), or (b) the human is interactively logged into the Infisical
# CLI — creds live in the OS keyring with no env var, so login is detected by a
# quick silent dev-env probe. The .infisical.json gate stops an ambient token /
# login for some OTHER project from silently hijacking the local stack. Otherwise
# 'local' (committed dummy defaults), so a fresh clone with no login boots zero-setup.
#
# Zero-login teammate onboarding: an Infisical credential placed in .env.local
# (INFISICAL_TOKEN, or a machine identity INFISICAL_MACHINE_CLIENT_ID +
# INFISICAL_MACHINE_CLIENT_SECRET) is pulled into the env before detection, so a
# teammate can boot the whole stack from Infisical with NO interactive login: a
# service token is used directly; a machine identity is exchanged for a short-lived
# access token (the same Universal Auth flow as scripts/with-infisical.sh).
#
# Usage: scripts/with-secrets.sh -- <command> [args...]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "${1:-}" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "usage: with-secrets.sh -- <command...>" >&2; exit 2; }

# Bootstrap-from-.env.local: let a teammate start the stack with NOTHING but an
# Infisical credential in .env.local (no interactive `infisical login`). Pull ONLY
# the INFISICAL_* bootstrap vars out of .env.local into the environment BEFORE
# backend detection, so the env-credential path below can see them. Parsed as DATA
# (KEY=VALUE, surrounding quotes stripped), never executed; the real shell env wins
# (an explicit export still overrides the file). The rest of .env.local is applied
# later, also as data, by the local backend.
if [ -f "$ROOT_DIR/.env.local" ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      INFISICAL_TOKEN=*|INFISICAL_MACHINE_CLIENT_ID=*|INFISICAL_MACHINE_CLIENT_SECRET=*|INFISICAL_API_URL=*|INFISICAL_PROJECT_ID=*|INFISICAL_SECRET_ENV=*|INFISICAL_ENV=*)
        _key=${_line%%=*}; _val=${_line#*=}
        case "$_val" in
          \"*\") _val=${_val#\"}; _val=${_val%\"} ;;
          \'*\') _val=${_val#\'}; _val=${_val%\'} ;;
        esac
        [ -n "${!_key:-}" ] || export "$_key=$_val"
        ;;
    esac
  done < "$ROOT_DIR/.env.local"
fi

# The Infisical env the local stack reads (ADR-0020 var, default 'dev'). Shared by
# the login probe and the actual `infisical run`, so the probe validates the same
# env we then boot on.
INFISICAL_ENV_RESOLVED="${INFISICAL_SECRET_ENV:-${INFISICAL_ENV:-dev}}"

# True when the Infisical CLI can fetch the dev env *right now*. An interactive
# `infisical login` stores creds in the OS keyring (no env var) and there is no
# clean status subcommand, so the only reliable signal is an end-to-end probe: a
# silent secret fetch running the no-op `true`. Succeeds only if keyring login +
# the pinned project (.infisical.json) + the env are all reachable; fails fast (no
# network hang) when not logged in. One extra fetch (~1s), paid only on a logged-in
# auto-detect — never when SECRETS_BACKEND is explicit or no login exists. A
# separate probe (not "try the real run, fall back on failure") is deliberate: the
# real run wraps the dev stack, whose own non-zero exit must NOT be misread as a
# secrets failure that re-runs everything on dummy values.
infisical_logged_in() {
  local runner=""
  if command -v timeout >/dev/null 2>&1; then runner="timeout 12"
  elif command -v gtimeout >/dev/null 2>&1; then runner="gtimeout 12"; fi
  $runner infisical run --env="$INFISICAL_ENV_RESOLVED" --path=/ --silent -- true >/dev/null 2>&1
}

backend="${SECRETS_BACKEND:-}"
if [ -z "$backend" ]; then
  if [ -f "$ROOT_DIR/.infisical.json" ] && [ -n "${INFISICAL_TOKEN:-}${INFISICAL_MACHINE_CLIENT_ID:-}" ]; then
    # CI / machine identity: an env-injected Infisical credential is present.
    backend=infisical
  elif [ -f "$ROOT_DIR/.infisical.json" ] && command -v infisical >/dev/null 2>&1 && infisical_logged_in; then
    # Human dev: interactively logged in (keyring, no env var). Auto-use the dev env
    # instead of silently booting on dummy secrets. Force dummy with SECRETS_BACKEND=local.
    backend=infisical
    echo "[with-secrets] auto-selected 'infisical' — interactive login detected (env=$INFISICAL_ENV_RESOLVED). Override with SECRETS_BACKEND=local." >&2
  else
    backend=local
    # Nudge only when the tooling is present but login is missing — never on a bare
    # fresh clone, which legitimately wants the zero-setup committed dummy secrets.
    if [ -f "$ROOT_DIR/.infisical.json" ] && command -v infisical >/dev/null 2>&1; then
      echo "[with-secrets] using committed dummy dev secrets — not logged into Infisical. Run 'infisical login' (or set SECRETS_BACKEND=infisical) for real dev secrets." >&2
    fi
  fi
fi

case "$backend" in
  infisical)
    command -v infisical >/dev/null 2>&1 || {
      echo "[with-secrets] SECRETS_BACKEND=infisical but the 'infisical' CLI is not installed." >&2
      echo "[with-secrets] Install it and 'infisical login', or use SECRETS_BACKEND=local." >&2
      exit 1
    }
    # Resolve a token so a teammate can boot with ONLY a credential in .env.local
    # (no interactive login), in priority order:
    #   1. INFISICAL_TOKEN — a service token, used directly.
    #   2. machine identity (Universal Auth) — CLIENT_ID + CLIENT_SECRET exchanged
    #      for a short-lived access token (same flow as scripts/with-infisical.sh).
    #   3. neither — fall through to the interactive OS-keychain login.
    _tok="${INFISICAL_TOKEN:-}"
    if [ -z "$_tok" ] && [ -n "${INFISICAL_MACHINE_CLIENT_ID:-}" ] && [ -n "${INFISICAL_MACHINE_CLIENT_SECRET:-}" ]; then
      _login_args=(--method=universal-auth --client-id="$INFISICAL_MACHINE_CLIENT_ID" --client-secret="$INFISICAL_MACHINE_CLIENT_SECRET" --plain --silent)
      [ -n "${INFISICAL_API_URL:-}" ] && _login_args+=(--domain="$INFISICAL_API_URL")
      _tok="$(infisical login "${_login_args[@]}" 2>/dev/null || true)"
      [ -n "$_tok" ] || echo "[with-secrets] machine-identity login failed (check INFISICAL_MACHINE_CLIENT_ID/_SECRET); trying interactive login." >&2
    fi
    # A machine-identity / service token is NOT inherently project-scoped, so a
    # token-based `infisical run` needs --projectId explicitly (the interactive
    # keychain login reads it from .infisical.json instead). Resolve it: an explicit
    # INFISICAL_PROJECT_ID wins, else the workspaceId pinned in .infisical.json.
    # Mirrors scripts/with-infisical.sh, which always passes --projectId with --token.
    _proj="${INFISICAL_PROJECT_ID:-}"
    if [ -z "$_proj" ] && [ -f "$ROOT_DIR/.infisical.json" ]; then
      _proj="$(sed -n 's/.*"workspaceId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/.infisical.json" | head -1)"
    fi
    # Same env the auto-detect probe validated (ADR-0020 var, default 'dev').
    if [ -n "$_tok" ]; then
      _run_args=(run --token="$_tok" --env="$INFISICAL_ENV_RESOLVED" --path=/)
      [ -n "$_proj" ] && _run_args+=(--projectId="$_proj")
      [ -n "${INFISICAL_API_URL:-}" ] && _run_args+=(--domain="$INFISICAL_API_URL")
      exec infisical "${_run_args[@]}" -- "$@"
    fi
    exec infisical run --env="$INFISICAL_ENV_RESOLVED" --path=/ -- "$@"
    ;;
  local)
    # Fail CLOSED outside local dev: dev-defaults.sh ships DUMMY encryption keys;
    # never let a production/CI process boot on them.
    if [ "${NODE_ENV:-}" = "production" ] || [ -n "${CI:-}" ]; then
      echo "[with-secrets] refusing committed dev defaults with NODE_ENV=production or CI set." >&2
      echo "[with-secrets] Set SECRETS_BACKEND=infisical (or provide real env) for non-local runs." >&2
      exit 1
    fi
    [ -f "$ROOT_DIR/scripts/dev-defaults.sh" ] || {
      echo "[with-secrets] missing scripts/dev-defaults.sh (the local fallback)." >&2
      exit 1
    }
    set -a
    # dev-defaults.sh is repo-controlled and safe to source.
    # shellcheck source=/dev/null
    . "$ROOT_DIR/scripts/dev-defaults.sh"
    set +a
    # .env.local is user-authored → parse as DATA (KEY=VALUE), never execute it,
    # so a pasted value containing $(...), backticks, ; etc. cannot run as a command.
    if [ -f "$ROOT_DIR/.env.local" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; esac
        case "$line" in *=*) : ;; *) continue ;; esac
        key=${line%%=*}
        val=${line#*=}
        case "$val" in
          \"*\") val=${val#\"}; val=${val%\"} ;;
          \'*\') val=${val#\'}; val=${val%\'} ;;
        esac
        export "$key=$val"
      done < "$ROOT_DIR/.env.local"
    fi
    exec "$@"
    ;;
  *)
    echo "[with-secrets] unknown SECRETS_BACKEND='$backend' (expected 'local' or 'infisical')." >&2
    exit 2
    ;;
esac
