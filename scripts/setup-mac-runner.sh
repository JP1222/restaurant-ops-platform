#!/usr/bin/env bash
# Bootstrap a Example Kitchen GitHub Actions self-hosted runner on a Mac
# (Mac Mini or MacBook — same setup, same `mac` label).
#
# Captures all the macOS-specific quirks discovered during the 2026-05-19
# Oracle -> Mac cutover (ADR-0008). Re-runnable for adding a second/third
# runner on the same machine, or for recovering one Mac after a wipe.
#
# Usage:
#   scripts/setup-mac-runner.sh <runner-name> <registration-token>
#
# Where:
#   <runner-name>          unique name, e.g. mac-mini-1, macbook-pro-1
#   <registration-token>   from https://github.com/example-org/restaurant-ops-platform/settings/actions/runners/new
#                          (one-time, expires in ~1 hour)
#
# Prerequisites on the host:
#   - macOS arm64
#   - python3, docker (OrbStack or Docker Desktop), git
#   - User account that owns the runner is logged into GUI (LaunchAgents
#     are user-scope and need the user logged in to start)

set -euo pipefail

# ---------- args ----------
RUNNER_NAME="${1:-}"
RUNNER_TOKEN="${2:-}"
if [[ -z "$RUNNER_NAME" || -z "$RUNNER_TOKEN" ]]; then
  echo "usage: $0 <runner-name> <registration-token>" >&2
  exit 64
fi

REPO_URL="${REPO_URL:-https://github.com/example-org/restaurant-ops-platform}"
RUNNER_OWNER="example-org"
RUNNER_REPO="restaurant-ops-platform"
RUNNER_VERSION="${RUNNER_VERSION:-2.334.0}"
LABELS="mac"

INSTALL_ROOT="$HOME"
INSTALL_DIR="$INSTALL_ROOT/actions-runner-${RUNNER_NAME##*-}"   # e.g. ~/actions-runner-1
HELPER_DIR="$INSTALL_ROOT/runner-bin"
HELPER_PATH="$HELPER_DIR/docker-credential-osxkeychain"
PLIST_LABEL="actions.runner.${RUNNER_OWNER}-${RUNNER_REPO}.${RUNNER_NAME}"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

EXTRA_PATH_PREFIX="$HELPER_DIR"

echo "==> Runner name:   $RUNNER_NAME"
echo "==> Install dir:   $INSTALL_DIR"
echo "==> Helper script: $HELPER_PATH"
echo "==> Plist:         $PLIST_PATH"
echo

# ---------- preflight ----------
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 1; }
command -v docker  >/dev/null || { echo "docker not found (install OrbStack)" >&2; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "expected arm64 Mac, got $(uname -m)" >&2; exit 1; }

# ---------- 1. download + extract runner ----------
if [[ ! -d "$INSTALL_DIR" ]]; then
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  TARBALL="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
  echo "==> Downloading $TARBALL"
  curl -fsSL -o "$TARBALL" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
  tar xzf "$TARBALL"
  rm "$TARBALL"
else
  echo "==> Reusing existing $INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ---------- 2. register runner ----------
if [[ ! -f .runner ]]; then
  echo "==> Registering runner with GitHub"
  ./config.sh --unattended \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$LABELS" \
    --replace
else
  echo "==> Runner already registered (skipping config.sh)"
fi

# ---------- 3. install LaunchAgent ----------
if ! launchctl list "$PLIST_LABEL" >/dev/null 2>&1; then
  echo "==> Installing LaunchAgent service"
  ./svc.sh install
else
  echo "==> LaunchAgent already installed"
fi

# ---------- 4. write file-based credential helper ----------
# OrbStack ships /usr/local/bin/docker-credential-osxkeychain, which needs an
# Aqua security session to write the Keychain. launchd-spawned jobs lack that
# session and fail with errSecInteractionNotAllowed (-25308). We shadow that
# binary by putting a same-named, plain-file helper earlier in PATH (see §6).
mkdir -p "$HELPER_DIR"
cat > "$HELPER_PATH" <<'HELPER_PY'
#!/usr/bin/env python3
"""Plain-file docker credential helper for GHA runner on macOS."""
import json
import os
import sys
import hashlib

STORE_DIR = os.path.expanduser("~/.docker/runner-creds")
os.makedirs(STORE_DIR, exist_ok=True)
os.chmod(STORE_DIR, 0o700)


def path_for(server: str) -> str:
    return os.path.join(STORE_DIR, hashlib.sha256(server.encode()).hexdigest()[:16] + ".json")


cmd = sys.argv[1] if len(sys.argv) > 1 else ""
stdin = sys.stdin.read().strip()

if cmd == "store":
    data = json.loads(stdin)
    p = path_for(data["ServerURL"])
    with open(p, "w") as f:
        json.dump(data, f)
    os.chmod(p, 0o600)
elif cmd == "get":
    p = path_for(stdin)
    if not os.path.isfile(p):
        # Empty creds + exit 0 means "anonymous". buildkit-in-container does
        # not honor the standard "exit 1 + 'credentials not found'" idiom.
        sys.stdout.write(json.dumps({"ServerURL": stdin, "Username": "", "Secret": ""}))
        sys.exit(0)
    with open(p) as f:
        sys.stdout.write(f.read())
elif cmd == "erase":
    # Intentional no-op. Both GHA runners run as the same OS user and
    # share ~/.docker/runner-creds/. If one job's post-step runs
    # `docker logout` -> helper erase while another runner has an
    # in-flight buildx push, the push loses creds mid-export and dies
    # with 403 ("anonymous token"). Next docker login rewrites the file,
    # so erase has no cleanup value. (Discovered 2026-05-20 on backoffice-web,
    # the slowest build in the matrix.)
    pass
elif cmd == "list":
    out = {}
    for fn in os.listdir(STORE_DIR):
        try:
            with open(os.path.join(STORE_DIR, fn)) as f:
                d = json.load(f)
            out[d["ServerURL"]] = d.get("Username", "")
        except Exception:
            pass
    sys.stdout.write(json.dumps(out))
else:
    sys.stderr.write(f"unknown command: {cmd}\n")
    sys.exit(2)
HELPER_PY
chmod +x "$HELPER_PATH"
echo "==> Wrote helper: $HELPER_PATH"

# ---------- 5. user-level docker config ----------
# Tell docker to not look for a helper at all; the per-PATH shadowing
# (next step) takes care of the launchd-context case.
mkdir -p "$HOME/.docker"
if [[ ! -f "$HOME/.docker/config.json" ]] || ! grep -q '"credsStore"' "$HOME/.docker/config.json"; then
  echo '{"credsStore":""}' > "$HOME/.docker/config.json"
fi

# ---------- 6. prefix PATH in 3 places ----------
# The runner has three layers of PATH override; all need the helper dir in
# front. Skipping any one of them leaks the OrbStack helper into job steps.
patch_path_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if grep -q "^$EXTRA_PATH_PREFIX:" "$file"; then
    echo "==> $file already prefixed"
    return 0
  fi
  python3 - "$file" "$EXTRA_PATH_PREFIX" <<'PY'
import sys, pathlib
path_file, prefix = sys.argv[1], sys.argv[2]
p = pathlib.Path(path_file)
text = p.read_text()
if path_file.endswith("/.env"):
    text = text.replace("PATH=", f"PATH={prefix}:", 1)
else:
    text = f"{prefix}:" + text
p.write_text(text)
PY
  echo "==> Prefixed $file"
}

patch_path_file "$INSTALL_DIR/.env"
patch_path_file "$INSTALL_DIR/.path"

# Plist EnvironmentVariables PATH (for runner.Listener itself).
if [[ -f "$PLIST_PATH" ]] && ! grep -q "$EXTRA_PATH_PREFIX" "$PLIST_PATH"; then
  python3 - "$PLIST_PATH" "$EXTRA_PATH_PREFIX" <<'PY'
import sys, pathlib, re
plist, prefix = sys.argv[1], sys.argv[2]
text = pathlib.Path(plist).read_text()
extra = (
    f"      <key>PATH</key>\n"
    f"      <string>{prefix}:/opt/homebrew/bin:/opt/homebrew/sbin:"
    f"/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>\n"
)
# Inject right before the closing </dict> of the EnvironmentVariables block.
m = re.search(r"(<key>EnvironmentVariables</key>\s*<dict>\s*(?:.*?\n)?)(\s*</dict>)", text, re.S)
if not m:
    raise SystemExit("EnvironmentVariables block not found in plist")
new = m.group(1) + extra + m.group(2)
pathlib.Path(plist).write_text(text[:m.start()] + new + text[m.end():])
PY
  echo "==> Plist PATH patched"
fi

# ---------- 7. reload service ----------
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"

echo
echo "Runner '$RUNNER_NAME' is live."
echo "Verify at: ${REPO_URL}/settings/actions/runners"
echo "Or:        gh api /repos/${RUNNER_OWNER}/${RUNNER_REPO}/actions/runners --jq '.runners[] | select(.name==\"$RUNNER_NAME\")'"
