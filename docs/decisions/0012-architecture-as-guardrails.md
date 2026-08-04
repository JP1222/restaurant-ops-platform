# ADR-0012: Architecture as guardrails — the AI-agent contract

- **Status**: Accepted
- **Date**: 2026-05-24
- **Deciders**: @example-org

## Context

Example Kitchen is developed almost entirely by AI agents. The architecture's invariants — the five Iron Laws, the contract pipeline, the BFF boundary — were written as **prose** in `AGENTS.md` and `ARCHITECTURE.md`. Prose is advisory: an agent can read "Backoffice never writes the KDS DB," build a feature that does exactly that, and ship it green because nothing fails the build.

That is not hypothetical. The Phase 7 AI assistant added business tables to the KDS database and wrote to them from `backoffice-web`, violating Laws 1 and 5 (see ADR-0011). No lint, test, or CI gate caught it. The drift was found only by a later manual architecture review. For a codebase whose primary author is an AI, **an invariant that isn't machine-checked will eventually be violated.**

## Decision

Treat the architecture as **executable guardrails**, not documentation. Every load-bearing boundary gets a check that fails the build; prose explains *why*, the check enforces *that*.

**Boundary enforcement (Iron Laws → ESLint).** `eslint.config.mjs` uses `no-restricted-imports` with path-scoped flat-config blocks:

- Law 1/5 — `analytics-api` may not import `@rop/db-kds`; `kds-web` may not import it; `backoffice-web` may import it only under `lib/auth/**` and `lib/ai/**` (ADR-0011).
- Law 3 — `@node-rs/argon2` (password hashing) is importable only inside `packages/auth`.

**Drift enforcement (docs/contracts → CI gates), building on existing scripts:**

- `scripts/check-doc-drift.sh` asserts every Prisma `model` in `schema.prisma` is named in `ARCHITECTURE.md`, and every workspace app/package has an `AGENTS.md`. (This rule alone would have caught the AI tables.)
- ~~`scripts/sync-contracts.sh --check` regenerates the Swift contracts to a temp dir and fails if `ios/.../Generated/Contracts.swift` is stale — contract drift becomes a red build (Law 2 for the native client).~~ **Retired 2026-06-03**: the native contract-sync gate (and the Swift build/test jobs) were removed from `ci.yml` when iOS development was paused. This specific check is no longer a live red-build mechanism; `scripts/sync-contracts.sh` is now manual-only. The decision below is unchanged — the guardrails principle still holds for the remaining web/contract boundaries.
- `scripts/validate-compose-env.py` (ADR-0007) keeps Dokploy env in sync.

**The agent contract.** Before declaring a task done, an agent runs `pnpm lint && pnpm build && pnpm test && pnpm docs:check` (and `pnpm test:e2e` when touching UI flows). To *cross* a boundary on purpose, an agent must (1) write an ADR and (2) add a scoped lint carve-out citing it — as ADR-0011 does for `lib/ai`. **Silent crossing fails the build; deliberate crossing is a reviewed, documented carve-out.** `AGENTS.md` carries a "Machine-enforced boundaries" table mapping each law to its check.

## Consequences

- The Iron Laws stop being honor-system. A boundary violation is a local `pnpm lint` failure an agent sees immediately, not a review-time catch.
- Carve-outs are self-documenting: the only way to legitimately cross a boundary leaves an ADR + a commented lint exception behind.
- Small ongoing cost: adding a genuinely new boundary means adding a rule; the per-block restriction set must be re-declared because ESLint rule options don't merge across flat-config blocks (documented in `eslint.config.mjs`).
- These checks catch *direct* import violations and named drift, not every conceivable architectural smell (e.g. transitive coupling). They are a floor, not a ceiling; the review guidelines in `AGENTS.md` still apply.

## Alternatives considered

- **dependency-cruiser** for boundary rules. More powerful (transitive, orphan detection) but adds a tool, a config, and pnpm-monorepo module-resolution setup. For "package X must not be imported in app Y," ESLint `no-restricted-imports` is sufficient and rides the existing `pnpm lint`. Revisit if we need transitive or layering rules.
- **Keep prose, rely on review.** This is the status quo that already failed (ADR-0011). Rejected.
- **Custom CI script per law.** More flexible but reinvents what ESLint already does well for imports; harder for an agent to run locally than `pnpm lint`.
