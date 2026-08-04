# ADR-0626: Documentation status banners, placement rules, and machine-checked link integrity

- **Status**: Accepted
- **Date**: 2026-06-12
- **Deciders**: @example-org

## Context

The doc corpus had grown three failure modes, each observed in production use of the docs by AI agents:

1. **The live handoff was 80% history.** Root `HANDOFF.md` reached 738 lines, of which ~600 were phase closeouts marked "kept for history" — including two sections explicitly banner-marked *do not follow*. Every agent session loads it at startup, so each session paid the token/attention cost of filtering ~100 lines of current truth out of 738, with a real risk of acting on superseded narratives (e.g. the pre-Phase-0 "Known Debt" list, the Codex-era AI rollout).
2. **Currency was unknowable without reading the whole doc.** Historical markers were ad-hoc (`⚠️ Post-Dokploy 状态`, `**Status**: SHIPPED`, `kept for history`, or nothing at all) — no format an agent or a grep could rely on. The 2026-06-03 cleanup audit (PR #494) fixed 32 misleading docs; within 9 days new drift had accumulated (4 stale Dokploy references in a doc written *after* the removal, `/settings/system` pointing at what had become a redirect, `compose-dokploy/` commands in live ops runbooks).
3. **Broken links were invisible.** Doc moves kept severing inbound relative links (4 fixed in PR #506); nothing failed when a link target disappeared. A first run of a link checker found **29 broken relative links** already in the tree.

A repeated meta-failure tied these together: migrations that retired a term (Dokploy, `compose-dokploy/`) updated code and compose but no step owned sweeping the docs, so live runbooks kept runnable-but-wrong commands for a week+.

## Decision

Four conventions, documented in root `AGENTS.md` § "Documentation conventions" (normative text lives there; this ADR records the rationale):

1. **Status banners.** Every handoff / plan / audit / archive doc under the repo root and `docs/` opens with a banner whose first line starts `> **Status:** ` (templates: `current`, `historical — superseded by <link>`, `historical record — decisions still binding`; qualify freely). Canonical docs carry none — drift checks keep them honest instead. Agents read the banner before trusting content.
2. **Placement + a slim HANDOFF.md.** Domain handoffs → `docs/<domain>-handoff.md`; audits → `docs/audits/YYYY-MM-DD-<slug>.md`; retired long-form narratives → `docs/archive/` (with the pre-existing phase docs deliberately left in place per the 2026-06-04 cleanup rulings). Root `HANDOFF.md` stays a short current-state document — production reality, open threads, operational log; closeout-style records graduate to `docs/archive/HANDOFF-phase-closeouts.md`.
3. **A migration that retires a term owns the doc sweep**, in the same PR — sweep live docs, then either add the dead term to the stale-pattern grep (only if it should appear nowhere) or rely on status banners where historical docs legitimately mention it.
4. **Doc link integrity is machine-enforced.** `scripts/check-doc-links.py` (inside `pnpm docs:check`) fails the build when a tracked markdown file's relative link targets a nonexistent file. Existence-only by design (anchors are not validated — too renderer-dependent for the value). `ALLOWLIST` covers intentional dead targets (e.g. legal-site routes); `SKIP_FILES` covers verbatim records whose quoted links are relative to *other* files — **verbatim records stay verbatim**; we exempt rather than rewrite history to satisfy a checker.

## Consequences

- `HANDOFF.md` went 738 → 85 lines; the 17 moved sections live verbatim in `docs/archive/HANDOFF-phase-closeouts.md`. Load-bearing facts documented nowhere else (AI ops levers, e2e auth-bypass nuance, internal-token fail-safe semantics) were restated in the slim file — and re-verified against code, which caught the old narrative drifting from reality (the chat brain is provider-selectable now, not DeepSeek-locked).
- A doc move or deletion that severs links now fails `pnpm docs:check` instead of waiting for the next audit (29 pre-existing breaks were fixed when the check landed).
- The banner format gives both agents and tooling a one-line currency check; ad-hoc historical markers were normalized across 24 docs.
- Cost accepted: one more check in `docs:check` (~1s), and authors of new handoff/plan/audit docs must add a one-line banner.

## Alternatives considered

- **Anchor-validating link checker** — rejected: renderer-dependent slug rules make it noisy; file existence catches the real failure mode (moves/deletes).
- **Auto-generated docs site / wiki** — rejected as over-engineering for a single-merchant repo; it would also split "docs as agent context" into two sources of truth.
- **Front-matter metadata blocks** instead of blockquote banners — rejected: blockquotes render on GitHub, front-matter doesn't; agents read raw markdown either way.
- **Adding retired terms (e.g. `Dokploy`) to the stale-pattern grep wholesale** — rejected: historical docs legitimately mention them; the grep is reserved for terms that should appear nowhere, banners handle the rest.
