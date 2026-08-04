#!/usr/bin/env bash
# Scaffold a new ADR as a `0000-` placeholder. The id is assigned LATER: after you
# open the PR, rename `0000-` to the PR number (Rust-RFC style — see ADR-0037).
# That late, PR-number-based assignment is what makes parallel ADR authoring
# collision-proof across worktrees. `pnpm docs:check` REDs a committed `0000-`
# placeholder, so you cannot forget the rename.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo 'usage: scripts/new-adr.sh "<short title — a verb phrase>"' >&2
  exit 1
fi

title="$*"
slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
dir="docs/decisions"
file="$dir/0000-$slug.md"

[ -e "$file" ] && { echo "already exists: $file" >&2; exit 1; }

cat > "$file" <<EOF
# ADR-0000: $title

- **Status**: Proposed
- **Date**: $(date +%Y-%m-%d)
- **Deciders**: @example-org

## Context

<!-- What's the problem? What constraints are in play? Cite the incident / PR / memory note that prompted this. -->

## Decision

<!-- What did we choose? Be specific — "use X", not "be careful about X". -->

## Consequences

<!-- What does this make easy / hard? What new risks? What will future-us live with? -->

## Alternatives considered

<!-- What else was on the table, and why rejected? One short paragraph each. Include "do nothing". -->
EOF

echo "created $file"
cat <<'EOF'

NEXT (this is the collision-proof part — ADR-0037):
  1. write the ADR, commit, push, open the PR.
  2. take the PR number N and rename the file + fix the header:
       git mv docs/decisions/0000-<slug>.md docs/decisions/<N, zero-padded to 4>-<slug>.md
       sed -i '' 's/^# ADR-0000:/# ADR-<N>:/' the renamed file   # (BSD/macOS sed)
     then add the row to docs/decisions/README.md's index.
  Do NOT pick a number yourself — the PR number IS the id.
EOF
