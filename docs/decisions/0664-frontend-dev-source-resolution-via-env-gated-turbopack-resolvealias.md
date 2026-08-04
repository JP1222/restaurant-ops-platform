# ADR-0664: Frontend dev-source resolution via env-gated Turbopack resolveAlias

- **Status**: Accepted
- **Date**: 2026-06-15
- **Deciders**: @example-org

## Context

Every shared package is compiled `src/*.ts` → `dist/*.js` + `dist/*.d.ts` by `tsc`. Consumers resolve the compiled `dist/` through the `import` export condition. So a shared-package **source** change that isn't followed by a package rebuild leaves the consumer reading a **stale `dist/`** — and the app fails to compile. The prompting incident: `backoffice-web` failed with `Export mergeReceiptLines doesn't exist` (added to `contracts` source but never built to `dist`) and rendered a full-screen build-error overlay instead of the login page — "can't log in" was a stale-dist compile failure, not auth.

The three tsx backends already avoided this in dev: each `@rop/*` package carries a private `yr-src` export condition (`→ ./src/*.ts`) and the backends run with `NODE_OPTIONS='--conditions=yr-src'`, so they import package **source** directly (live cross-package reload; no `dist` needed to boot). The condition is private, so `pnpm build`, tests, and prod — which pass no condition — provably resolve `dist`. The **Next frontends were the explicitly-deferred half** ([docs/LOCAL-DEV-GUIDE.md](../LOCAL-DEV-GUIDE.md) §6); they still resolved `dist` and remained exposed to stale-dist. (Landed in PR #660.)

## Decision

Frontends reach package **source** in dev via an **env-gated `turbopack.resolveAlias`**, not a custom condition (Turbopack has no such knob — see Alternatives).

- `config/yr-src-map.mjs` is the single source of truth. It **derives** each app's `resolveAlias` map and `transpilePackages` additions from the app's own dependencies and each package's own `yr-src` export targets — so the four `next.config.ts` are identical and cannot re-diverge, and a new app gets correct wiring for free.
- The alias map is `{}` unless `YR_SRC=1`. The flag is set **only** in the four `dev` scripts; `next build` / `next start` / tests / prod never set it, so they keep resolving `dist`.
- Alias **values are repo-root-relative** — Turbopack rejects absolute-path values as "server relative imports".
- Pre-existing drift is closed in the same change (db-crm gains `yr-src`; crm-api `dev`/`dev:worker` + kds-api `dev:worker` gain the Node condition; root `db:generate` gains db-crm), and `scripts/check-doc-drift.sh` enforces the whole wiring (every package has `yr-src`; every backend/frontend carries the wiring; no `yr-src`/`YR_SRC` token leaks into a `Dockerfile` or `compose/*.yml`), registered in the [AGENTS.md](../../AGENTS.md) machine-enforced-boundaries table.

## Consequences

- **Easy now**: editing a shared package in dev no longer breaks the frontend build on stale `dist`; the four frontends are wired identically and drift is machine-prevented; backends and frontends share one mental model ("dev resolves source").
- **Prod safety** rests on three independent seams (the Node condition is private/opt-in; the frontend alias is env-gated; every Docker build recompiles `dist` fresh) plus a fail-the-build leak grep — verified by a deliberate stale-dist test (`YR_SRC=1 next build` compiles a src-only symbol imported via the `@rop/contracts/match` subpath; the same build without the flag fails on the missing dist symbol).
- **We live with**: in dev, *runtime* resolves source but TypeScript *types* still resolve to `dist/*.d.ts` until the package is rebuilt — a new src export runs but shows a red squiggle until the next lib build. This is identical to the backends' long-standing behavior and is accepted (see Alternative 4).

## Alternatives considered

1. **Wire a custom `yr-src` condition into Turbopack** (the literal deferred follow-up). Rejected: Next 16 Turbopack exposes no `resolveConditions`/custom-condition knob ([vercel/next.js#78912](https://github.com/vercel/next.js/discussions/78912) is open; a maintainer confirmed "there's no way to enforce export resolution condition in Turbopack"). `resolveAlias` is the supported substitute that reaches the same goal.

2. **`transpilePackages` parity** (add every shared package to each frontend's `transpilePackages`). Rejected as a **false fix**: `transpilePackages` governs *compilation* of the already-resolved file, never *resolution* — `kds-web` and `crew-web` already transpiled `@rop/contracts` yet still broke on stale dist. It is retained only as the mandatory companion that compiles the raw TS the alias resolves to.

3. **Keep `dist` always-fresh via `turbo watch build`** (no resolution change). Rejected: the frontend half rests on the unproven claim that Turbopack re-bundles a changed `node_modules/*/dist` file in place, which contradicts Turborepo's documented restart pattern for non-dependency-aware tools; and it discards the backends' proven instant src hot-reload for a 0.5–2 s `tsc` emit per cross-package edit.

4. **`customConditions: ["yr-src"]` in `tsconfig.base.json`** to also resolve source for *types* in dev and close the type-staleness gap. Implemented and **rejected after verification**: it requires reordering every package's `exports` (`yr-src` before `types`) and — because the IDE and CI share the same tsconfigs — it makes CI `tsc --noEmit` resolve package *source*, which breaks under Next's `isolatedModules` (e.g. `packages/auth/src/server/password.ts` accesses an ambient const enum that `skipLibCheck` hides today over the dist `.d.ts`: `TS2748: Cannot access ambient const enums when 'isolatedModules' is enabled`). Fixing it would mean changing working package source for a cosmetic dev convenience. The type-staleness in Consequences is accepted instead.

5. **Do nothing** — rebuild packages after pulling / restart dev. Rejected: a recurring, unenforceable foot-gun that also leaves the frontends permanently inconsistent with the backends.
