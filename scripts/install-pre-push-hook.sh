#!/usr/bin/env bash
# Installs the local-only Example Kitchen pre-push hook.
#
# Opt-in: each contributor runs this once. The hook lives under .git/ and is
# NOT tracked in the repo (no Husky, no `prepare` script, no contributor-wide
# install). Bypass any single push with `git push --no-verify`.
#
# Usage:
#   bash scripts/install-pre-push-hook.sh           # refuse if hook exists
#   bash scripts/install-pre-push-hook.sh --force   # overwrite existing
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FORCE=0
if [ "${1:-}" = "--force" ] || [ "${1:-}" = "-f" ]; then
  FORCE=1
fi

# Resolve the hooks directory. Honor `core.hooksPath` if the user set one;
# otherwise fall back to <git-common-dir>/hooks so the install works from a
# worktree too (worktrees share hooks with the main checkout).
HOOKS_PATH="$(git config --get core.hooksPath 2>/dev/null || true)"
if [ -z "$HOOKS_PATH" ]; then
  COMMON_DIR="$(git rev-parse --git-common-dir)"
  case "$COMMON_DIR" in
    /*) HOOKS_PATH="$COMMON_DIR/hooks" ;;
    *)  HOOKS_PATH="$ROOT_DIR/$COMMON_DIR/hooks" ;;
  esac
fi

mkdir -p "$HOOKS_PATH"
HOOK_FILE="$HOOKS_PATH/pre-push"

if [ -e "$HOOK_FILE" ] && [ "$FORCE" -ne 1 ]; then
  echo "Refusing to overwrite existing hook: $HOOK_FILE"
  echo "Re-run with --force to replace it, or remove it first:"
  echo "  rm \"$HOOK_FILE\""
  exit 1
fi

cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
# restaurant-ops-platform pre-push hook — runs lint + typecheck locally before push.
# Bypass with: git push --no-verify
set -euo pipefail
START=$(date +%s)
echo "[pre-push] running pnpm lint + typecheck..."
pnpm lint
pnpm exec turbo run typecheck
ELAPSED=$(($(date +%s) - START))
echo "[pre-push] ✓ done in ${ELAPSED}s"
HOOK

chmod +x "$HOOK_FILE"

echo "✓ Installed $HOOK_FILE"
echo "  This runs \`pnpm lint\` + \`turbo run typecheck\` on every \`git push\`."
echo "  Bypass once:  git push --no-verify"
echo "  Uninstall:    rm \"$HOOK_FILE\""
