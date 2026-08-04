#!/bin/sh
# sessions.sh — one glance at what every parallel worktree / agent session is doing.
#
# The antidote to opaque branch codenames (jolly-poincare-cc88e0, funny-diffie-b0cb26):
# each worktree should carry a SESSION.md (gitignored) declaring its purpose in three
# lines — Feature / Phase / Intent. This walks every worktree and prints branch + that
# declaration, with a SOFT ⚠ flag (never an error) when a session is undeclared, missing
# a field, or stale. It is deliberately soft: a hard pre-work gate is friction at the
# worst moment; run this as a glance for a while before considering any CI-red.
#
# Usage: bash scripts/sessions.sh   (or: sh scripts/sessions.sh)
set -eu

mtime_of() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

git worktree list --porcelain | while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt=${line#worktree } ;;
    "detached")   printf '\n● (detached HEAD)\n  ↳ %s\n' "$wt" ;;
    "branch "*)
      br=${line#branch refs/heads/}
      printf '\n● %s\n  ↳ %s\n' "$br" "$wt"
      f="$wt/SESSION.md"
      if [ ! -f "$f" ]; then
        printf '  ⚠ undeclared — what is this session doing? add:\n'
        printf '    printf "Feature: <x>\\nPhase: <y>\\nIntent: <z>\\n" > %s/SESSION.md\n' "$wt"
      elif ! { grep -q '^Feature:' "$f" && grep -q '^Phase:' "$f" && grep -q '^Intent:' "$f"; }; then
        printf '  ⚠ incomplete — SESSION.md needs all three: Feature: / Phase: / Intent:\n'
        sed 's/^/    /' "$f"
      else
        last_commit=$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo 0)
        if [ "$(mtime_of "$f")" -lt "$last_commit" ]; then
          printf '  ⚠ stale — SESSION.md is older than the last commit here; still on this?\n'
        fi
        sed 's/^/    /' "$f"
      fi
      ;;
  esac
done

printf '\n'
