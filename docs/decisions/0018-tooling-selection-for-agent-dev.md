# ADR-0018: Tooling selection rubric for AI-agent-driven development

- **Status**: Accepted
- **Date**: 2026-05-28
- **Deciders**: @example-org

> **⚠️ Shared ADR number.** The number **0018** is also used by [`0018-multi-location-architecture.md`](0018-multi-location-architecture.md) — a parallel-branch collision (both authored 2026-05-28). Per the immutability convention ([README](README.md#superseding-an-adr): *"Never delete an ADR"*; numbers are never reused-by-renaming), neither was renumbered. Cite the full filename, not the bare number, when cross-referencing. **This** ADR is the *tooling-selection rubric* one.

## Context

Example Kitchen is built and operated almost entirely by **directing AI agents**
(Claude Code, Codex/DeepSeek). The human is director + reviewer; the second
teammate is non-CLI (project memory: *team ops preference*). This is not
traditional team development, and it changes what makes a tool a good fit.

Conventional tool evaluation silently assumes buffers this model lacks:

- Humans hold context between sessions. **Agents don't** — each session
  re-derives state from the file tree.
- Humans operate GUIs. **Agents operate text** — CLI, API, config files.
- Humans absorb tribal knowledge. **Agents only know what's written down.**
- Humans notice when something looks off. **Agents drift**, and drift is
  invisible unless something turns red.

We had been evaluating tools one at a time (Dokploy, Sentry, GlitchTip)
without a written standard, which meant re-litigating the same reasoning each
time. This ADR names the standard so tool selection — including selection done
*by* an agent — has a fixed rubric to align to. It generalizes reasoning
already encoded in ADR-0005 (Dokploy), ADR-0012 (guardrails), ADR-0014 (Sentry).

## Decision

Evaluate every tool against a **7-criterion rubric**. The scarce resource is
the director's review attention, not code output — so a tool earns its place by
being **agent-operable**, by **failing loud when the agent is wrong**, and by
being **cheap to undo**.

### The rubric

1. **State lives as text in the repo, not in a GUI.** Config-as-code, schemas,
   declarative YAML/TOML. The agent reads/edits files; it is blind to state
   trapped in a web UI.
2. **Driven by a typed API or CLI, not click-only.** If the agent must operate
   it, it needs a programmable surface (CLI, tRPC, REST+schema, `gh`).
3. **Fails loud and deterministically.** Mistakes surface as a red build, not a
   production surprise or a review-time catch. Machine-enforced guardrails
   (lint rules, schema checks, CI gates).
4. **Fast local verification.** The agent's bottleneck is *verification*, not
   generation. Fast feedback (typecheck, tests, cached builds) multiplies
   throughput per unit of director attention.
5. **Self-documenting via files the agent reads.** Conventions recoverable from
   `AGENTS.md` / ADRs each session; no out-of-band tribal knowledge.
6. **Low lock-in / reversible.** The agent will occasionally be wrong; cheap
   undo (no proprietary format, git-revertable config) caps the downside.
7. **Rent the stateful / high-liability rails (SaaS); build the brain (code).**
   Agents write code well but cannot operate a stateful service over time
   (migrations, disk pressure); neither can a non-CLI teammate. Self-host only
   with a strong reason.

### Combined strategy

Criteria **#3 + #7** are the load-bearing pair:

> **Machine-guard everything the agent is allowed to touch (so drift turns
> red), and rent the stateful things the agent can't operate (so nobody has to
> babysit them).** The director then watches only the residue machines can't
> enforce.

### One-line rule

> Can the agent drive it? Will it go red when the agent is wrong? Is it
> stateful and something I'd have to operate forever? — If drivable +
> red-on-error and (stateless or rentable), it fits. Otherwise don't adopt it,
> however capable it is.

## Worked scorecard

✅ pass · ⚠️ partial · ❌ fail · — n/a

| Criterion | GlitchTip (rejected) | Dokploy (kept) | Sentry (kept) |
|---|---|---|---|
| 1 Text-in-repo | ❌ state in its DB | ⚠️ compose in repo, **env in Dokploy DB** → needs `validate-compose-env.py` | ✅ `sentry.*.config.ts` + scrub in repo |
| 2 Typed API/CLI | ⚠️ Sentry-compat API | ✅ tRPC (the deciding factor, ADR-0005) | ✅ SDK + `sentry-cli` |
| 3 Fails loud | ⚠️ only if wired | ❌ native (env drift + 5-19 disk pressure were **silent**); patched by your CI | ✅ it **is** the fail-loud tool; release-tagged |
| 4 Fast local verify | — | — (deploy plane, not inner loop) | ✅ 8 vitest scrub tests |
| 5 Self-documenting | ❌ Django ops lore | ⚠️ install quirks live in RUNBOOK/memory, not the tool | ✅ ADR-0014 + config files |
| 6 Low lock-in | ❌ events trapped in its PG | ✅ plain docker; DR = host compose | ✅ vendor-neutral SDK; switch = 1 DSN |
| 7 Rent stateful rails | ❌ self-hosted PG+redis+web+worker to babysit | ⚠️ self-hosted control plane; **manages unbacked DBs** | ✅ textbook SaaS stateful store |
| **Verdict** | **Misfit → removed** | **Conditional fit** | **Clean fit (~7/7)** |

Reading the scorecard:

- **Sentry — clean fit.** Passes all seven; it embodies #3 (the tool that makes
  other failures loud) and #7 (rent the stateful rail). Its only open issue is
  *execution*, not fit: client-side capture isn't wired yet (ADR-0014
  follow-up #2) — a half-connected wire, not a wrong tool.
- **Dokploy — conditional fit.** It nails the two load-bearing criteria for
  agent-dev (#2 drivable, #6 reversible), which is *why it's defensible*. But it
  fails #3 natively and is partial on #1/#5/#7 — and every one of those gaps is
  patched by guardrails *built around it* (`validate-compose-env.py`, the
  runbook, and the still-open DB-backup + disk-monitoring work). Those patches
  are its standing cost. It fits, but it's the kind that needs a guardrail
  bolted on, not the kind that's safe by construction.
- **GlitchTip — textbook misfit.** Failed #3/#6/#7 (silent, locked-in,
  self-hosted stateful with ongoing ops). Correctly removed (ADR-0014).

## Consequences

**Makes easy:**

- Tool selection — including selection done by an agent — has a fixed standard
  to cite instead of re-deriving it each time.
- Explains retroactively *why* the current stack looks the way it does, so
  future-us doesn't re-open settled choices.

**Makes hard / costs:**

- The rubric biases toward SaaS for stateful services, trading self-hosting
  control + cost for operability. Acceptable at single-merchant scale; revisit
  if SaaS spend or data-residency pressure grows.
- A tool can score well and still be under-delivered in practice (Sentry's
  unwired client capture). The rubric judges *fit*, not *completion* — track
  completion separately.

**New risks:**

- Over-applied, the rubric could reject a genuinely better tool that happens to
  be GUI-first. The one-line rule is a default, not a law; a strong reason can
  override it — record the override in a new ADR.

## Alternatives considered

- **No written rubric (status quo).** Rejected — it's what caused the repeated
  per-tool re-litigation this ADR ends.
- **A heavier scoring framework** (weighted matrix, numeric thresholds).
  Rejected as overkill for a one/two-person shop; 7 near-binary checks + a
  one-line rule are enough to make the call.
- **Fold this into ADR-0012** (architecture-as-guardrails). Rejected — 0012 is
  about *enforcing* boundaries inside the codebase; this is about *selecting*
  external tools. Related but distinct; cross-linked instead.

## Related

- [ADR-0005](./0005-dokploy-over-coolify.md) — Dokploy chosen for its tRPC API
  (criterion #2) + plain-docker reversibility (#6).
- [ADR-0012](./0012-architecture-as-guardrails.md) — machine-enforced
  boundaries (criterion #3), the in-codebase counterpart.
- [ADR-0014](./0014-sentry-saas-over-glitchtip.md) — Sentry over GlitchTip; the
  clean-fit-vs-misfit pair worked above.
- [ADR-0007](./0007-validate-compose-env-script.md) — the guardrail that patches
  Dokploy's criterion-#1 gap.
- Project memory: *team ops preference* (non-CLI teammate → criterion #7),
  *build-vs-buy philosophy* ("build the brain, rent the rails").
