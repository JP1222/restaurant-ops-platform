#!/usr/bin/env python3
"""Fail the build if any workflow runs on a GitHub-hosted (paid) runner without
an explicit carve-out.

Why this exists: in May 2026, `ci.yml` and `build-images.yml` sat on
GitHub-hosted `ubuntu-latest` runners (build-images under QEMU arm64 emulation)
and quietly burned ~3,977 paid Actions minutes over 8 days — exhausting the
monthly free allowance and then spending real money — before anyone noticed.
Every job now runs on the self-hosted mac pool (ADR-0008), which is free.
This check makes that boundary machine-enforced (ADR-0012) instead of
honor-system, so a workflow can never silently drift back onto a paid runner
(e.g. a copy-pasted `runs-on: ubuntu-latest`, or a Dependabot bump that flips a
reusable action's default).

Policy: every `runs-on:` in .github/workflows/*.yml must resolve to a
self-hosted runner. To deliberately use a GitHub-hosted runner (mac pool down,
a genuine one-off Linux-only job), add an inline carve-out comment on the same
line — mirroring the ADR-0011 scoped-exception pattern:

    runs-on: ubuntu-latest  # allow-hosted: mac mini offline, one-off backfill

The repo's GitHub spending cap bounds the cost of such intentional use; this
check only blocks *silent* hosted usage, so it never removes that paid fallback.
"""

import re
import sys
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
REPO_ROOT = WORKFLOWS.parent.parent

RUNS_ON = re.compile(r"^(\s*)runs-on:\s*(.*?)\s*$")
LIST_ITEM = re.compile(r"^(\s*)-\s*(.*?)\s*$")

ALLOW_MARKER = "allow-hosted"


def _code(text: str) -> str:
    """Value part of a YAML scalar, dropping any trailing # comment.

    Runner labels never contain '#', so splitting on the first one is safe.
    """
    return text.split("#", 1)[0].strip()


def _has_allow(text: str) -> bool:
    return ALLOW_MARKER in (text.split("#", 1)[1] if "#" in text else "")


def check_file(path: Path):
    """Return a list of (line_number, offending_text) for hosted-runner uses
    that lack a carve-out."""
    violations = []
    lines = path.read_text().splitlines()
    i, n = 0, len(lines)
    while i < n:
        m = RUNS_ON.match(lines[i])
        if not m:
            i += 1
            continue
        indent, rest = m.group(1), m.group(2)
        value = _code(rest)

        if value == "":
            # Block-list form:
            #   runs-on:
            #     - self-hosted
            #     - mac
            # Gather the more-indented list items (and any carve-out comment
            # anywhere in the block) and judge them together.
            labels, allowed = [], _has_allow(rest)
            j = i + 1
            while j < n:
                stripped = lines[j].strip()
                if stripped == "" or stripped.startswith("#"):
                    allowed = allowed or (ALLOW_MARKER in lines[j])
                    j += 1
                    continue
                lm = LIST_ITEM.match(lines[j])
                if lm and len(lm.group(1)) > len(indent):
                    labels.append(_code(lm.group(2)))
                    allowed = allowed or _has_allow(lines[j])
                    j += 1
                    continue
                break
            if "self-hosted" not in " ".join(labels) and not allowed:
                violations.append((i + 1, "runs-on: " + (" ".join(labels) or "(empty)")))
            i = j
            continue

        # Inline form: `runs-on: [self-hosted, mac]` or `runs-on: ubuntu-latest`.
        if "self-hosted" not in value and not _has_allow(rest):
            violations.append((i + 1, lines[i].strip()))
        i += 1
    return violations


def main() -> int:
    files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    if not files:
        print(f"No workflow files found under {WORKFLOWS}", file=sys.stderr)
        return 1

    total = 0
    for f in files:
        rel = f.relative_to(REPO_ROOT)
        for lineno, text in check_file(f):
            total += 1
            # GitHub Actions annotation + a plain line for local runs.
            print(f"::error file={rel},line={lineno}::GitHub-hosted runner without carve-out")
            print(f"  {rel}:{lineno}  {text}")

    if total:
        print()
        print(f"Runner policy check FAILED: {total} job(s) target a GitHub-hosted (paid) runner.")
        print("Every job must run on the self-hosted mac pool (ADR-0008) — it's free,")
        print("and a silent regression to a paid runner is what burned the allowance in May 2026.")
        print("If you genuinely need a hosted runner, add an inline carve-out, e.g.:")
        print("    runs-on: ubuntu-latest  # allow-hosted: <reason>")
        print("Your spending cap still bounds the cost; this only blocks *silent* hosted usage.")
        return 1

    print(f"Runner policy check passed: all jobs across {len(files)} workflow(s) are self-hosted (or carved out).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
