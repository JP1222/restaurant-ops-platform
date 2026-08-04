#!/usr/bin/env bash
# Install the Example Kitchen heartbeat monitor on a Mac Mini.
#
# Idempotent. The script is COPIED into ~/rop-heartbeat/ rather than
# referenced from the repo path, so the agent survives:
#   - rebooting the Mac (which wipes /tmp)
#   - moving/deleting the source repo checkout
# Re-run this installer after pulling new code to update the deployed copy.
#
# Usage:
#   scripts/heartbeat/setup-heartbeat.sh [SLACK_WEBHOOK_URL]
#
# If the webhook URL is omitted and ~/rop-heartbeat/.env doesn't yet
# exist, the script will prompt for it.

set -euo pipefail

WEBHOOK_ARG="${1:-}"
PLIST_LABEL="com.example.heartbeat"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
ROOT="$HOME/rop-heartbeat"
LOG_DIR="$ROOT/log"

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SOURCE_SCRIPT="$REPO_ROOT/scripts/heartbeat/heartbeat.py"
PLIST_TEMPLATE="$REPO_ROOT/scripts/heartbeat/com.example.heartbeat.plist.template"

if [[ ! -f "$SOURCE_SCRIPT" ]]; then
    echo "missing $SOURCE_SCRIPT" >&2
    exit 1
fi
if [[ ! -f "$PLIST_TEMPLATE" ]]; then
    echo "missing $PLIST_TEMPLATE" >&2
    exit 1
fi

mkdir -p "$ROOT" "$LOG_DIR"
chmod 700 "$ROOT"

# ---------- copy script into a stable, persistent location ----------
# launchd plist must point at a path that survives reboot. Repos in /tmp
# (or ephemeral /private/tmp on macOS) don't.
INSTALLED_SCRIPT="$ROOT/heartbeat.py"
cp "$SOURCE_SCRIPT" "$INSTALLED_SCRIPT"
chmod +x "$INSTALLED_SCRIPT"
echo "==> copied heartbeat.py to $INSTALLED_SCRIPT"

# ---------- env file (Slack webhook etc.) ----------
ENV_FILE="$ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -z "$WEBHOOK_ARG" ]]; then
        printf 'Slack incoming webhook URL (https://hooks.slack.com/services/...): '
        read -r WEBHOOK_ARG
    fi
    if [[ -z "$WEBHOOK_ARG" ]]; then
        echo "no webhook provided; aborting" >&2
        exit 64
    fi
    printf 'SLACK_WEBHOOK_URL=%s\n' "$WEBHOOK_ARG" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "==> wrote $ENV_FILE (chmod 600)"
else
    echo "==> reusing existing $ENV_FILE"
fi

# ---------- render plist from template ----------
ESCAPED_SCRIPT=$(python3 -c 'import sys, html; print(html.escape(sys.argv[1]))' "$INSTALLED_SCRIPT")
ESCAPED_LOG_DIR=$(python3 -c 'import sys, html; print(html.escape(sys.argv[1]))' "$LOG_DIR")

sed -e "s|__SCRIPT_PATH__|$ESCAPED_SCRIPT|g" \
    -e "s|__LOG_DIR__|$ESCAPED_LOG_DIR|g" \
    "$PLIST_TEMPLATE" > "$PLIST_PATH"
echo "==> rendered plist: $PLIST_PATH"

# ---------- (re)load LaunchAgent ----------
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "==> launchctl loaded $PLIST_LABEL"

# ---------- show first run (RunAtLoad fires within a second) ----------
echo
echo "Waiting ~5s for first run …"
sleep 5
if [[ -f "$LOG_DIR/out.log" ]]; then
    echo "------ tail of $LOG_DIR/out.log ------"
    tail -10 "$LOG_DIR/out.log"
fi
if [[ -s "$LOG_DIR/err.log" ]]; then
    echo "------ tail of $LOG_DIR/err.log ------"
    tail -10 "$LOG_DIR/err.log"
fi

echo
echo "Installed. Verify:"
echo "  launchctl list | grep $PLIST_LABEL"
echo "  tail -f $LOG_DIR/out.log"
echo "  cat $ROOT/state.json"
