# ADR-0037: ADR identifiers are the pull-request number (parallel-safe numbering)

- **Status**: Accepted
- **Date**: 2026-06-04
- **Deciders**: @example-org
- **Amends**: the contiguous-sequential numbering convention in [README](README.md) (its Template, "Superseding an ADR", and the implicit "monotonic sequence" of [ADR-0002](0002-five-iron-laws.md)). The legacy block **0001–0037 is grandfathered and immutable**, including the three shared numbers 0014, 0018, and 0033.

## Context

ADR numbers have been assigned "next free number = max + 1", computed **independently in each branch / worktree**. With multiple AI agents authoring ADRs in **parallel git worktrees** (this repo regularly has ~20), two agents routinely pick the same number against the same base `main`, producing duplicate-numbered ADRs — **0014, 0018, and 0033 each collided exactly this way** (see the README note; the `0033` collision was itself undocumented until the guard below surfaced it). The standing workaround ("accept the collision, cite the full filename") is a band-aid, not a fix.

This is the canonical ADR/RFC numbering problem ([MADR issue #28](https://github.com/adr/madr/issues/28): *"Numbering sequence can break when different PRs create ADRs at the same time"*). The root cause is structural: **a contiguous-sequential scheme requires coordination** — a single shared counter — and parallel branches cannot coordinate without serializing. The solutions floating around are weak: a lock file authors forget to bump; switch to GUIDs (unreadable); subfolder categories (collision still possible within a category); a CI duplicate-check that only catches a collision *after* it has been authored.

The battle-tested, zero-coordination answer used by the largest parallel-proposal systems — **[Rust RFCs](https://github.com/rust-lang/rfcs)** (and React, Ember, which copied it) — is to make **the pull-request number the identifier**. You author with a `0000` placeholder and "use the issue number of the PR to rename the file". GitHub assigns PR numbers **atomically and monotonically**, so two parallel authors can never receive the same id, with no shared counter anywhere.

## Decision

**New ADRs use their pull-request number as the id, Rust-RFC style.**

1. Author the file as `docs/decisions/0000-<slug>.md` with header `# ADR-0000: <title>`. The `0000` is a placeholder — **do not pick a number**. `scripts/new-adr.sh "<title>"` scaffolds this from the template.
2. Open the PR. GitHub assigns it number `N`.
3. Rename `0000-<slug>.md` → `<N, zero-padded to ≥4>-<slug>.md`, change the header to `# ADR-<N>:`, add the [README](README.md) index row, and fix any cross-references. (An agent does this right after `gh pr create`. A duplicate is now impossible — PR numbers are unique.)

**Guardrail — enforced by `pnpm docs:check`** (`scripts/check-doc-drift.sh`): the build fails if

- **(a)** any two ADR files share a number — excluding the grandfathered `0014` / `0018` / `0033`; or
- **(b)** any committed ADR still carries the `0000-` placeholder (you forgot to rename it to the PR number).

A collision or a forgotten rename is now a **red check**, never a silent dupe.

**Legacy is immutable.** ADRs `0001`–`0037` keep their contiguous numbers; **this ADR (`0037`) is the last manually-assigned one** — it is authored serially with no parallel author, so it is collision-free. Numbering is **non-contiguous from here on**: ids jump to PR numbers (e.g. `0001`…`0037`, then `0512`, `0540`, …). This gap is the inherent, accepted cost of zero-coordination parallel-safe ids — exactly what Rust RFCs live with. The [README](README.md) index remains the source of reading order.

## Consequences

- Two agents in parallel worktrees can **never collide on an ADR id again** — the id does not exist until the PR does, and PR numbers are globally unique and monotonic.
- ADR ids are no longer gap-free; they read like Rust RFC numbers. Cross-references must use the full filename (already the README convention) or the `ADR-<PR#>` form.
- One extra step per ADR: rename `0000-` → the PR number after opening the PR. A forgotten rename is caught by the `docs:check` guard, not shipped.
- **Optional future enhancement (NOT done here):** a GitHub Action that auto-renames `0000-*.md` to the PR number on PR open and patches the header + index — removing the manual rename entirely. Recorded so it is not re-discovered from scratch.

## Alternatives considered

- **CI duplicate-number guard alone, keep sequential** — rejected as the *primary* fix: it catches collisions but does not prevent them; the second PR still has to renumber (a re-work loop), and a stale-green AI self-merge can still land a dupe. (It is adopted here as a *safety net* alongside the PR-number scheme.)
- **Lock file holding the latest number** ([MADR #28](https://github.com/adr/madr/issues/28)'s only concrete proposal) — rejected: relies on every author remembering to bump it; forgotten → zero protection. Worse for agents than humans.
- **Assign the next sequential number at merge via a bot** — rejected: preserves contiguity but needs a post-merge bot that auto-renumbers and commits to `main`; more machinery and less standard than the PR-number convention, for the sole benefit of gap-free numbers.
- **GUID / ULID ids** — rejected: collision-free but unreadable and unordered; defeats the at-a-glance ordering an ADR log is meant to provide.
