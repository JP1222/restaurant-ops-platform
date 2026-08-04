# ADR-0587: AI semantic match for invoice receiving (confidence-gated tier)

- **Status**: Proposed
- **Date**: 2026-06-06
- **Deciders**: @example-org
- **Extends**: [ADR-0586](./0586-learned-vendor-aliases-for-invoice-receiving.md) (learned vendor aliases) · [ADR-0538](./0538-ai-invoice-scan-for-receiving-via-deepseek-vision.md) (AI invoice scan)

## Context

ADR-0586 made invoice→item matching deterministic and self-improving: **tier 0** a learned
vendor alias (instant, free, exact), **tier 1** a fuzzy match on the AI's clean canonical
name. A line that misses both defaults to "create new item." That's the right default the
*first* time a product is seen — but it also fires when an equivalent catalog item **already
exists** under wording the fuzzy matcher can't bridge (a heavy rename, a translation, a
spelled-out vs abbreviated unit). The result is the exact duplicate-item sprawl ADR-0586
set out to prevent, just pushed to the residual cases.

This is a strong-AI system; the natural fix for "the deterministic tiers can't tell, but a
human instantly could" is to ask the model — **safely**, within the guard rails ADR-0538
already established (the model proposes, the human commits, and it never invents a SKU).

## Decision

Add **tier 2 — AI semantic match** to the matcher, for residual lines only, behind a
confidence gate. Five parts.

### D1 — Tier 2 runs only on the residual, and only proposes among real items

After tiers 0–1, lines still unmatched (defaulted to create-new) are sent to the model with
the **live catalog candidate list** (`id` + `name`). The model picks the single best
candidate id per line, or null. A deterministic guard drops any returned id that isn't in
the candidate set (hallucination guard) and clamps confidence to 0..1 — so, exactly as in
ADR-0538 D3, the model can never introduce a SKU the catalog doesn't have. A fully-matched
scan makes **no** AI call.

### D2 — A confidence gate, operator-tunable

`ai.match_confidence_threshold` (new `app_setting`, brand tier, default **0.7**). A
suggestion is auto-applied only at/above it; below, it's ignored and the line stays a
create-new candidate. The operator still reviews and commits every line (ADR-0538 D4);
manually repointing a line clears the AI provenance so the "AI NN%" hint can't lie.

### D3 — A metered BFF route, same contract as the other AI calls

`POST /api/inventory/match-suggest` (backoffice BFF) mirrors the chat / receipt-parse
gating: kill-switch, session **or** `INTERNAL_AI_TOKEN` auth (so crew-web can proxy later,
like the scan route), rate limit, fail-closed 503 when unkeyed. It uses the **text** chat
brain (not the vision model) — cheaper, since the input is text. The client call is
**best-effort**: any failure (disabled / unkeyed / rate-limited / error) silently leaves the
deterministic result, so receiving is never blocked on the AI.

### D4 — The loop closes itself (amortizes to zero)

An AI-suggested match the operator confirms commits through the Phase-1 ad-hoc receive,
which **learns the alias** (the raw line carries through). So the next invoice with that
wording is a deterministic tier-0 hit — the AI call is paid once per (vendor, wording), then
never again. Tier 2 is a teacher for tier 0, not a permanent dependency.

### D5 — Shared, guarded, leaf-imported

`applyMatchSuggestions` (threshold + valid-id guard) lives in the `@rop/contracts/match`
leaf and is unit-tested; the server `suggestCatalogMatches` applies the same valid-id guard
before the wire. Client code imports the leaf, never the package barrel — the Phase-1
Turbopack-chunk lesson (a barrel value-import into a global client chunk tripped a latent TDZ).

## Consequences

- **Easy**: fewer duplicate items from residual lines; matching that genuinely reasons over
  meaning, not tokens; zero marginal cost once a wording is learned; one tunable knob.
- **Hard / new risks**:
  - A wrong high-confidence suggestion mis-maps a line. Mitigated by the threshold, the
    human commit, and provenance-clearing on manual repoint — and a bad confirm is undone
    like any receive.
  - Prompt size scales with catalog size (candidates are sent inline). Fine for a
    single-merchant catalog (hundreds of items); a per-line candidate prefilter is the
    follow-up if a catalog grows large.
  - One more metered AI surface — covered by the existing kill-switch + rate limit.
- **Scope (this PR)**: backend + the **backoffice** receive-intake surface. **Crew-web**
  (proxy + scan-flow) and the **AI chat receipt card** reuse the same endpoint and are the
  immediate follow-up.

## Alternatives considered

- **Trust the model to emit the catalog SKU directly.** Rejected by ADR-0538 and here —
  invites hallucinated/duplicate ids; the candidate-guard + null is the safe shape.
- **Embedding / vector similarity search.** Strong recall, but needs an embedding store +
  indexing infra the suite doesn't have. Deferred; the alias loop (D4) reduces how often
  tier 2 is even needed, lowering the payoff of heavier infra.
- **Run AI match on every line, not just the residual.** Wasteful and it would override good
  deterministic tier-0/1 hits with a slower, costlier guess. Rejected — residual-only.
- **Do nothing (keep create-new as the residual default).** Leaves the duplicate-item gap
  ADR-0586 explicitly wanted closed. Rejected.
