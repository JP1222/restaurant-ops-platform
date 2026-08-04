# ADR-0002: Five Iron Laws as boundary enforcement

- **Status**: Accepted
- **Date**: 2026-05-09 (Phase 0 closeout; rules added to AGENTS.md)
- **Deciders**: @example-org

## Context

ADR-0001 chose a pnpm monorepo with 4 apps and 3 shared packages. Monorepos default to chaos: any file can `import` any other file; shared mutable state in one package can be poked from a distant app; one app can reach into another's database. Without rules, the structure that justified going monorepo (clean per-app boundaries with a shared contract layer) erodes within months.

Pre-monorepo Intelligence + KDS had at least two real instances of this drift even *across* repo boundaries (DTO duplication, Clover client logic duplication). The same forces apply inside one repo, just with less friction to drift.

The team is small (one human + AI agents) and reviews are tightly clustered in time. A boundary that exists only in a person's head won't survive 6 months. It needs to be:

1. **Written down** in a place every contributor (human or AI) reads first.
2. **Specific enough** to be a yes/no question on a PR.
3. **Few enough** to remember. (10 rules is "I'll check the doc"; 5 is "I know them.")

## Decision

Codify **five Iron Laws** at the top of [`AGENTS.md`](../../AGENTS.md). Every per-app `AGENTS.md` inherits them. Reviewers (human and AI) treat any violation as **high severity** — the kind that blocks merge.

The five laws (paraphrased; canonical text in `AGENTS.md`):

1. **Database boundary.** Each app owns its own Postgres database. KDS uses Prisma via `packages/db-kds`; analytics-api uses raw SQL with its own schema. Never cross-import database clients across apps.
2. **Contract boundary.** Cross-app DTOs flow through `packages/contracts` (Zod). No hand-written DTOs at app boundaries.
3. **Auth boundary.** Once `packages/auth` exists, all cookie-session and passkey logic flows through it. No app reimplements auth.
4. **Floor vs Backoffice boundary.** `apps/kds-web` is a Floor product (kitchen TVs, board, display). `apps/backoffice-web` is for owners and managers on desktop / mobile. Don't conflate the two — different UX, different refresh cadence, different error tolerance.
5. **Read sources are not write sources.** `apps/analytics-api` is read-only OLAP. It ingests Clover → mart but never writes to KDS's database, and Backoffice never writes to either. All writes flow through the originating service.

Each law has been actively enforced. A small sample of violations caught in review (or by author self-catch before review):

- A KDS feature that wanted to read `clover_merchants` from analytics-api's Postgres for token recovery → redirected to call the kds-api admin endpoint.
- A Backoffice analytics page that hand-rolled a JSON shape for the trends chart → moved into `packages/contracts` and shared with mobile.
- A KDS admin page that started rendering inline in `kds-web` → caught at Phase 4 and migrated to `backoffice-web` (the law was the migration prompt; see ADR-0003).

## Consequences

**Makes easy:**

- **PR review has a sharp test.** "Is this an Iron Law violation? If yes, block." Reviewers don't have to argue about taste.
- **Refactors stay local.** Because each app's domain boundary is enforced, a kds-api change can't accidentally reach into backoffice-web internals — there's nothing to reach into.
- **AI agents have aligned rules.** AGENTS.md is the same file Codex, Cursor, and Claude all read first. Aligning on five concrete rules is reliable in a way "be careful about boundaries" is not.

**Makes hard:**

- **Some genuinely useful shortcuts are forbidden.** E.g. backoffice would be slightly faster if it could read directly from analytics-api's Postgres rather than via HTTP. We pay the latency cost for the rule.
- **The shared-DB exception for auth is awkward.** `backoffice-web` connects to KDS's Postgres for `WebAdminAccount` + `WebAuthnCredential`. This *does* violate Law #1 strictly read, but is whitelisted in `AGENTS.md` because the auth tables are operationally owned by the auth product (passkeys), not by the KDS product. Documented but ugly.
- **New contributors must read AGENTS.md before their first PR.** The README's "see AGENTS.md" link is load-bearing.

**New risks:**

- A law that's frequently bent loses authority. If we ever say "yes, just this once, share the DB" without writing a new ADR superseding Law #1, the next "just this once" comes faster. Discipline matters.

## Alternatives considered

- **No formal laws — rely on review judgement.** This is what we had pre-monorepo and what caused the DTO drift between Intelligence and KDS. Rejected on track record.

- **More granular rules** (e.g. "no shared Redis", "no shared timezone constants", "BFF must validate with zod"). Rejected. The "5 laws" cap is intentional — they're memorable. Sub-rules belong in per-app `AGENTS.md`.

- **Enforce via tooling** (ESLint custom rules, dependency-cruiser, `pnpm` `dependenciesMeta.injected`). Considered. Today the rules are enforced by review only; we could harden with a `dependency-cruiser` rule that bans cross-app imports. Deferred — at single-merchant scale, review catches things fast enough. Worth revisiting if we add a third human contributor.

- **Stricter ownership** (e.g. one app per directory, no `packages/`). Rejected. That collapses the shared-contract layer that justifies the monorepo. The current shape — apps own behavior, packages own protocols — is the right grain.

## Related

- [ADR-0001: pnpm monorepo with four apps](./0001-pnpm-monorepo-with-four-apps.md) — the structure these laws protect.
- [ADR-0003: Floor vs Backoffice split](./0003-floor-vs-backoffice-split.md) — Phase 4 enforcement of Law #4.
- [`AGENTS.md`](../../AGENTS.md) — canonical text + review guidelines.
