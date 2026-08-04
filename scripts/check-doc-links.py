#!/usr/bin/env python3
"""Fail the build if a tracked markdown doc links to a repo file that doesn't exist.

Why this exists: doc reorganizations keep producing silently-broken relative
links — PR #506 fixed 4 of them after the 2026-06-03 cleanup audit, and the
2026-06-12 HANDOFF.md trim (phase closeouts moved to docs/archive/) is exactly
the kind of move that breaks inbound links again. `check-doc-drift.sh` catches
stale *content* patterns but had no idea whether a link target exists. This
check makes link integrity machine-enforced (ADR-0012 spirit): move or delete
a doc without fixing its inbound links and `pnpm docs:check` goes red.

Scope (deliberately narrow — every gate must earn its cost):
- Only git-TRACKED .md files are scanned, and only inline links/images
  `[text](target)` with a relative or repo-absolute path target.
- External links (http/https/mailto), pure in-page anchors (#...), and
  anything inside fenced code blocks or inline code spans are ignored.
- Anchors are NOT validated (only that the target file exists). Anchor
  validation is noisy across markdown renderers; existence catches the real
  failure mode (a moved/deleted file).
- A trailing `:<line>` suffix on a target is tolerated (file:line convention).

Intentional dead targets (e.g. a gitignored template a doc legitimately points
at) go in ALLOWLIST below with a comment saying why.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

# target -> reason it is allowed to not exist as a tracked file.
# Entries are matched against the EXACT raw link target (anchor included).
ALLOWLIST: dict[str, str] = {
    # docs/legal/SUPPORT.md is compiled into the legal-site; these are routes
    # on the deployed site (legal.example.com), not repo paths.
    "/eula": "legal-site route, resolved at serve time",
    "/privacy": "legal-site route, resolved at serve time",
}

# file -> reason the whole file is exempt. Reserved for verbatim records whose
# quoted links are deliberately relative to OTHER files — rewriting them to
# satisfy this checker would corrupt the record (the 2026-06-03 audit quotes
# fix-instructions destined for README/ARCHITECTURE/AGENTS, where the original
# relative paths are correct).
SKIP_FILES: dict[str, str] = {
    "docs/audits/2026-06-03-repo-cleanup-audit.md": "verbatim audit record; quoted links are relative to their destination files",
}

# tolerates an optional "title" after the target: [x](y "title")
INLINE_LINK = re.compile(r"!?\[[^\]]*\]\(<?([^)<>\s]+)>?(?:\s+\"[^\"]*\")?\)")
CODE_SPAN = re.compile(r"`[^`]*`")
# a fence may sit inside a blockquote ("> ```bash")
FENCE = re.compile(r"^\s*(?:>\s*)*(```|~~~)")


def tracked_markdown() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "*.md"], capture_output=True, text=True, check=True
    )
    return [f for f in out.stdout.splitlines() if f]


def target_exists(doc: str, target: str) -> bool:
    path = target.split("#", 1)[0]
    if not path:
        return True
    if path.startswith("/"):
        resolved = path.lstrip("/")
    else:
        resolved = os.path.normpath(os.path.join(os.path.dirname(doc), path))
    if os.path.exists(resolved):
        return True
    # tolerate the file:line convention ([foo.ts:42](src/foo.ts:42))
    base, sep, suffix = resolved.rpartition(":")
    if sep and suffix.isdigit() and os.path.exists(base):
        return True
    return False


def main() -> int:
    # resolve from the repo root regardless of invocation directory
    top = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True
    ).stdout.strip()
    os.chdir(top)
    broken: list[tuple[str, int, str]] = []
    for doc in tracked_markdown():
        if doc in SKIP_FILES:
            continue
        try:
            lines = open(doc, encoding="utf-8").read().splitlines()
        except OSError as err:
            print(f"warning: cannot read {doc}: {err}", file=sys.stderr)
            continue
        in_fence = False
        for lineno, line in enumerate(lines, 1):
            if FENCE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            for match in INLINE_LINK.finditer(CODE_SPAN.sub("", line)):
                target = match.group(1)
                if target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                if target in ALLOWLIST:
                    continue
                if not target_exists(doc, target):
                    broken.append((doc, lineno, target))

    if broken:
        print("Broken repo-relative markdown links:")
        for doc, lineno, target in broken:
            print(f"  {doc}:{lineno} -> {target}")
        print(
            "  -> fix the link, or if the dead target is intentional add it to"
            " ALLOWLIST in scripts/check-doc-links.py with a reason."
        )
        return 1

    print("Doc link check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
